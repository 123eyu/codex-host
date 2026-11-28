/** Kettu-inspired minimalist extension card / lightweight row and non-blank fading icon. */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  IconCheckCircleFillRegular,
  IconCheckOutlineRegular,
  IconDownloadOutlineRegular,
  IconWarningTriangleOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  DesktopExtensionCategory,
  DesktopExtensionTrustTier,
} from "@codexhost/shared-contracts";
import {
  categoryLabelForLocale,
  formatPositiveExtensionCount,
  parseSafeIconUrl,
  type ExtensionLocale,
  type ExtensionPlatformBadge,
  type Translate,
} from "./web-extensions-helpers.ts";
import css from "./WebExtensionsSection.module.css";

function CategoryGlyph({
  category,
  size,
  strokeWidth = 1.9,
}: {
  category: DesktopExtensionCategory;
  size: number;
  strokeWidth?: number;
}): ReactNode {
  const shared = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  switch (category) {
    case "appearance":
      return (
        <svg {...shared}>
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
          <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
        </svg>
      );
    case "interface":
      return (
        <svg {...shared}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
          <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
        </svg>
      );
    case "workflow":
      return (
        <svg {...shared}>
          <circle cx="6.5" cy="7" r="2.5" />
          <circle cx="17.5" cy="7" r="2.5" />
          <circle cx="17.5" cy="17" r="2.5" />
          <path d="M9 7h6" />
          <path d="M6.5 9.5V13a4 4 0 0 0 4 4H15" />
        </svg>
      );
    case "analytics":
      return (
        <svg {...shared}>
          <line x1="6.5" y1="18.5" x2="6.5" y2="13" />
          <line x1="12" y1="18.5" x2="12" y2="6.5" />
          <line x1="17.5" y1="18.5" x2="17.5" y2="10.5" />
          <line x1="4" y1="18.5" x2="20" y2="18.5" />
        </svg>
      );
    case "integrations":
      return (
        <svg {...shared}>
          <path d="M10 14a4.2 4.2 0 0 0 6 0l2.5-2.5a4.2 4.2 0 0 0-6-6L11 7" />
          <path d="M14 10a4.2 4.2 0 0 0-6 0L5.5 12.5a4.2 4.2 0 0 0 6 6L13 17" />
        </svg>
      );
    default:
      return (
        <svg {...shared}>
          <path d="M12 3.5l7.5 4.25v8.5L12 20.5l-7.5-4.25v-8.5L12 3.5z" />
          <path d="M12 12l7.5-4.25" />
          <path d="M12 12v8.5" />
          <path d="M12 12L4.5 7.75" />
        </svg>
      );
  }
}

export function ExtensionIcon({
  src,
  categories,
  size,
}: {
  src?: string | undefined;
  categories?: readonly DesktopExtensionCategory[] | undefined;
  size: "card" | "detail" | "sidebar";
}): ReactNode {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const safeUrl = parseSafeIconUrl(src);
  const category = categories?.[0] ?? "tools";
  const glyphSize = size === "detail" ? 26 : size === "sidebar" ? 13 : 22;

  useEffect(() => {
    if (!safeUrl || safeUrl === failedSrc || safeUrl === loadedSrc) return;
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      setLoadedSrc(safeUrl);
    }
  }, [safeUrl, failedSrc, loadedSrc]);

  const shouldTryImage = safeUrl !== null && safeUrl !== failedSrc;
  const isImageLoaded = shouldTryImage && loadedSrc === safeUrl;

  const sizeClass =
    size === "detail" ? css.iconDetail : size === "sidebar" ? css.iconSidebar : css.iconCard;

  return (
    <span
      className={`${css.icon} ${sizeClass}`}
      data-icon-kind={isImageLoaded ? "image" : "fallback"}
      data-icon-loaded={isImageLoaded ? "true" : undefined}
      data-icon-category={size === "sidebar" ? undefined : category}
      aria-hidden="true"
    >
      <span className={css.iconFallback} data-hidden={isImageLoaded ? "true" : undefined}>
        <CategoryGlyph category={category} size={glyphSize} />
      </span>
      {shouldTryImage && (
        <img
          ref={imgRef}
          src={safeUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className={css.iconImg}
          data-extension-icon
          data-loaded={isImageLoaded ? "true" : undefined}
          onLoad={() => setLoadedSrc(safeUrl)}
          onError={() => setFailedSrc(safeUrl)}
        />
      )}
    </span>
  );
}

export function WebExtensionPlatformBadge({ badge }: { badge: ExtensionPlatformBadge }) {
  return (
    <span className={css.capBadge} data-platform={badge.kind}>
      {badge.label}
    </span>
  );
}

export interface WebExtensionCardProps {
  readonly cardKey: string;
  readonly extensionId: string;
  readonly cardKind: "installed" | "market";
  readonly layout?: "featured" | "row" | undefined;
  readonly displayName: string;
  readonly description?: string | null | undefined;
  readonly iconUrl?: string | undefined;
  readonly author?: string | undefined;
  readonly version?: string | undefined;
  readonly downloads?: number | undefined;
  readonly trustTier?: DesktopExtensionTrustTier | undefined;
  readonly categories?: readonly DesktopExtensionCategory[] | undefined;
  /** Only shown when the extension is incompatible with the current host (e.g. Desktop-only in Web). */
  readonly incompatiblePlatformLabel?: string | undefined;
  readonly statusDot?:
    { readonly tone: "info" | "warning" | "danger"; readonly label: string } | undefined;
  readonly update?:
    { readonly version: string; readonly label: string; readonly action?: ReactNode } | undefined;
  readonly attention?: { readonly tone: "warning" | "danger"; readonly text: string } | undefined;
  readonly secondaryAction?: ReactNode;
  readonly actionControl: ReactNode;
  readonly busy?: boolean | undefined;
  readonly contentLocale: ExtensionLocale;
  readonly onOpenDetails: () => void;
  readonly t: Translate;
}

export function WebExtensionCard({
  cardKey,
  extensionId,
  cardKind,
  layout = "row",
  displayName,
  description,
  iconUrl,
  author,
  version,
  downloads,
  trustTier,
  categories,
  incompatiblePlatformLabel,
  statusDot,
  update,
  attention,
  secondaryAction,
  actionControl,
  busy = false,
  contentLocale,
  onOpenDetails,
  t,
}: WebExtensionCardProps): ReactNode {
  const trimmedAuthor = author?.trim() || undefined;
  const formattedVersion = version?.trim()
    ? version.trim().startsWith("v")
      ? version.trim()
      : `v${version.trim()}`
    : undefined;
  const formattedUpdateVersion = update?.version.trim()
    ? update.version.trim().startsWith("v")
      ? update.version.trim()
      : `v${update.version.trim()}`
    : undefined;
  const primaryCategoryKey: DesktopExtensionCategory = categories?.[0] ?? "tools";
  const primaryCategory =
    categories && categories.length > 0
      ? categoryLabelForLocale(categories[0]!, contentLocale)
      : undefined;
  const formattedDownloads = formatPositiveExtensionCount(downloads);
  const trimmedDescription = description?.trim() ?? "";

  const metaParts: string[] = [];
  if (primaryCategory) metaParts.push(primaryCategory);
  if (trimmedAuthor) metaParts.push(trimmedAuthor);
  const versionSummary =
    formattedVersion && formattedUpdateVersion
      ? `${formattedVersion} → ${formattedUpdateVersion}`
      : (formattedVersion ?? (formattedUpdateVersion ? update?.label : undefined));
  const downloadsLabel = formattedDownloads
    ? t("extensions.installsCount", { count: formattedDownloads })
    : undefined;
  const metaTitle = [
    ...metaParts,
    ...(versionSummary ? [versionSummary] : []),
    ...(downloadsLabel ? [downloadsLabel] : []),
  ].join(" · ");

  const stopBubble = (event: MouseEvent | KeyboardEvent) => {
    event.stopPropagation();
  };

  const titleNode = (
    <div className={css.cardTitleGroup}>
      <h3 className={css.cardTitle} title={displayName}>
        {displayName}
      </h3>
      {trustTier === "official" && (
        <span
          className={css.verifiedIcon}
          role="img"
          aria-label={t("extensions.trust.official")}
          title={t("extensions.trust.official")}
        >
          <IconCheckCircleFillRegular size={13} />
        </span>
      )}
      {statusDot !== undefined && (
        <span
          className={css.statusDot}
          data-tone={statusDot.tone}
          role="img"
          aria-label={statusDot.label}
          title={statusDot.label}
        />
      )}
      {incompatiblePlatformLabel && (
        <span className={css.compatHint} data-platform="desktop">
          {incompatiblePlatformLabel}
        </span>
      )}
    </div>
  );

  const versionNode = versionSummary !== undefined && (
    <span
      className={`${css.metaSegment} ${formattedUpdateVersion ? css.metaVersionUpgrade : ""}`}
      title={update?.label ?? versionSummary}
      aria-label={update?.label ?? versionSummary}
    >
      {formattedVersion && <span>{formattedVersion}</span>}
      {formattedUpdateVersion && (
        <span className={css.metaUpdateTarget}>
          <span className={css.metaUpdateArrow} aria-hidden="true">
            →
          </span>
          <span>{formattedUpdateVersion}</span>
        </span>
      )}
    </span>
  );

  const downloadsNode = formattedDownloads !== null && (
    <span
      className={`${css.metaSegment} ${css.metaDownloads}`}
      aria-label={downloadsLabel}
      title={downloadsLabel}
    >
      <IconDownloadOutlineRegular size={11} aria-hidden="true" />
      <span>{formattedDownloads}</span>
    </span>
  );

  const categorySegment = primaryCategory !== undefined && (
    <span className={`${css.metaSegment} ${css.metaCategory}`}>
      <span className={css.metaCategoryIcon} aria-hidden="true">
        <CategoryGlyph category={primaryCategoryKey} size={12} strokeWidth={1.8} />
      </span>
      <span>{primaryCategory}</span>
    </span>
  );

  const metaLine = (primaryCategory !== undefined ||
    trimmedAuthor !== undefined ||
    versionSummary !== undefined ||
    formattedDownloads !== null) && (
    <div className={css.metaLine} title={metaTitle}>
      {categorySegment}
      {trimmedAuthor && <span className={css.metaSegment}>{trimmedAuthor}</span>}
      {versionNode}
      {downloadsNode}
    </div>
  );

  const featuredMetaLine = (primaryCategory !== undefined ||
    trimmedAuthor !== undefined ||
    formattedUpdateVersion !== undefined ||
    formattedDownloads !== null) && (
    <div className={css.metaLine} title={metaTitle}>
      {categorySegment}
      {formattedUpdateVersion ? (
        versionNode
      ) : trimmedAuthor ? (
        <span className={css.metaSegment}>{trimmedAuthor}</span>
      ) : (
        versionNode
      )}
      {downloadsNode}
    </div>
  );

  const actionNode = (
    <div className={css.cardAction} onClick={stopBubble} onKeyDown={stopBubble}>
      {update?.action}
      {secondaryAction}
      {actionControl}
    </div>
  );

  return (
    <article
      className={layout === "featured" ? css.featuredCard : css.rowCard}
      data-web-extension={cardKey}
      data-extension-id={extensionId}
      data-card-kind={cardKind}
      data-layout={layout}
      data-busy={busy ? "true" : undefined}
      data-update-available={update ? "true" : undefined}
      tabIndex={0}
      role="button"
      aria-haspopup="dialog"
      aria-label={t("extensions.openDetailsLabel", { name: displayName })}
      aria-description={incompatiblePlatformLabel}
      onClick={onOpenDetails}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetails();
        }
      }}
    >
      {layout === "featured" ? (
        <>
          <div className={css.featuredTop}>
            <ExtensionIcon src={iconUrl} categories={categories} size="card" />
            {actionNode}
          </div>
          <div className={css.featuredBody}>
            {titleNode}
            {featuredMetaLine}
            {trimmedDescription !== "" && (
              <p className={css.featuredDescription} title={trimmedDescription}>
                {trimmedDescription}
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          <div className={css.rowIconWrap}>
            <ExtensionIcon src={iconUrl} categories={categories} size="card" />
          </div>
          <div className={css.rowMain}>
            <div className={css.rowTop}>
              {titleNode}
              {actionNode}
            </div>
            {metaLine}
            {trimmedDescription !== "" && (
              <p className={css.rowDescription} title={trimmedDescription}>
                {trimmedDescription}
              </p>
            )}
            {attention !== undefined && (
              <div className={css.cardAttention} data-tone={attention.tone} role="alert">
                <IconWarningTriangleOutlineRegular size={13} className={css.cardAttentionIcon} />
                <span>{attention.text}</span>
              </div>
            )}
          </div>
        </>
      )}
    </article>
  );
}

/** Small check icon helper for the "Installed" button on Marketplace items. */
export function InstalledCheckIcon(): ReactNode {
  return <IconCheckOutlineRegular size={13} />;
}
