import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const MACOS_SHELL_APP_RELATIVE = "libexec/CodexHost.app";
export const MACOS_SHELL_EXECUTABLE_PATH = `${MACOS_SHELL_APP_RELATIVE}/Contents/MacOS/CodexHost`;
export const MACOS_SHELL_SIGNATURE_PATH = `${MACOS_SHELL_APP_RELATIVE}/Contents/_CodeSignature/CodeResources`;
export const MACOS_SHELL_BUNDLE_PATHS = Object.freeze([
  `${MACOS_SHELL_APP_RELATIVE}/Contents/Info.plist`,
  MACOS_SHELL_EXECUTABLE_PATH,
  `${MACOS_SHELL_APP_RELATIVE}/Contents/PkgInfo`,
  `${MACOS_SHELL_APP_RELATIVE}/Contents/Resources/AppIcon.icns`,
  MACOS_SHELL_SIGNATURE_PATH,
]);

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createMacosShellInfoPlist(version) {
  const safeVersion = escapeXml(version);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>CodexHost</string>
  <key>CFBundleExecutable</key>
  <string>CodexHost</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>com.codexhost.shell</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>CodexHost</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${safeVersion}</string>
  <key>CFBundleVersion</key>
  <string>${safeVersion}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>CodexHost uses the microphone for voice input.</string>
</dict>
</plist>
`;
}

export function signMacosShellBundle(appPath, { signIdentity } = {}) {
  const identity = signIdentity ?? (process.env.CODEXHOST_MACOS_SIGN_IDENTITY || "-");
  // Bind Info.plist (CFBundleIdentifier = com.codexhost.shell) and seal bundle resources so
  // macOS usernotificationsd matches the signing identifier instead of the linker-signed binary name.
  execFileSync("/usr/bin/codesign", ["--force", "--sign", identity, appPath], {
    stdio: "pipe",
  });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "pipe",
  });
}

export async function stageMacosShellBundle({
  sourceExecutable,
  iconSource,
  destinationRoot,
  version,
  sign = process.platform === "darwin",
  signIdentity,
}) {
  const appPath = path.join(destinationRoot, MACOS_SHELL_APP_RELATIVE);
  const contentsDir = path.join(appPath, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");
  await mkdir(macosDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });

  const executableDestination = path.join(macosDir, "CodexHost");
  await copyFile(sourceExecutable, executableDestination);
  await chmod(executableDestination, 0o755);

  await copyFile(iconSource, path.join(resourcesDir, "AppIcon.icns"));
  await writeFile(path.join(contentsDir, "PkgInfo"), "APPL????", "utf8");
  await writeFile(path.join(contentsDir, "Info.plist"), createMacosShellInfoPlist(version), "utf8");
  if (sign) {
    signMacosShellBundle(appPath, { signIdentity });
  }
}
