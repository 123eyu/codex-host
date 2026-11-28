#![cfg(target_os = "macos")]

use std::path::PathBuf;
use std::process::Command;

#[test]
fn macos_notifications_bridge_handles_bundle_modes_and_delegates() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let work = tempfile::tempdir().unwrap();
    let fixture = work.path().join("notifications-test");
    assert!(
        Command::new("xcrun")
            .arg("clang")
            .current_dir(&root)
            .args([
                "-fobjc-arc",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-framework",
                "Foundation",
                "-framework",
                "UserNotifications",
            ])
            .args([
                "tests/macos_notifications.m",
                "src/macos_notifications.m",
                "-o",
            ])
            .arg(&fixture)
            .status()
            .unwrap()
            .success()
    );
    assert!(Command::new(&fixture).status().unwrap().success());

    let embedded_fixture = work.path().join("notifications-embedded-plist-test");
    let plist = root.join("Info.plist");
    assert!(
        Command::new("xcrun")
            .arg("clang")
            .current_dir(&root)
            .args([
                "-fobjc-arc",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-framework",
                "Foundation",
                "-framework",
                "UserNotifications",
                "-Wl,-sectcreate",
                "-Wl,__TEXT",
                "-Wl,__info_plist",
            ])
            .arg(format!("-Wl,{}", plist.display()))
            .args([
                "tests/macos_notifications.m",
                "src/macos_notifications.m",
                "-o",
            ])
            .arg(&embedded_fixture)
            .status()
            .unwrap()
            .success()
    );
    assert!(
        Command::new(&embedded_fixture)
            .arg("--embedded-plist")
            .status()
            .unwrap()
            .success()
    );
}
