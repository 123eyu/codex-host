// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshImageUrl, nextImageLoad } from "../src/markdown/image-load.ts";
import { MarkdownText, type MarkdownLabels } from "../src/markdown/MarkdownText.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LABELS: MarkdownLabels = {
  code: {
    copyLabel: "Copy",
    copiedLabel: "Copied",
    toolbarLabels: { codeLabel: "Code", wrapLabel: "Wrap", unwrapLabel: "Unwrap" },
  },
  footnotes: "Footnotes",
};

describe("freshImageUrl", () => {
  it("keeps URLs stable when load is omitted or non-positive", () => {
    const base = "http://localhost:4400/api/file?path=%2Ftmp%2Fshot%201.png";
    expect(freshImageUrl(base)).toBe(base);
    expect(freshImageUrl(base, 0)).toBe(base);
    expect(freshImageUrl(base, -1)).toBe(base);
  });

  it("appends a load tag only for positive retry numbers and preserves data/blob URLs", () => {
    const base = "http://localhost:4400/api/file?path=%2Ftmp%2Fshot%201.png";
    const load = nextImageLoad();
    expect(freshImageUrl(base, load)).toBe(`${base}&load=${load}`);
    expect(freshImageUrl("http://localhost:4400/image.png", load)).toBe(
      `http://localhost:4400/image.png?load=${load}`,
    );
    expect(freshImageUrl("data:image/png;base64,AAAA", load)).toBe("data:image/png;base64,AAAA");
    expect(freshImageUrl("blob:http://localhost/123", load)).toBe("blob:http://localhost/123");
  });
});

describe("MarkdownImage URL stability, retry, and unmount cleanup", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  it("keeps a stable local image URL across remounts without appending ?load=N", () => {
    const resolved = "http://localhost:4400/api/file?path=%2Ftmp%2Fscreen.png";
    const renderOnce = () => {
      act(() => {
        root.render(
          createElement(MarkdownText, {
            text: "![shot](/tmp/screen.png)",
            labels: LABELS,
            pathImages: { resolve: () => resolved },
          }),
        );
      });
    };

    renderOnce();
    const firstImg = host.querySelector("img");
    expect(firstImg).not.toBeNull();
    expect(firstImg!.getAttribute("src")).toBe(resolved);
    expect(firstImg!.getAttribute("loading")).toBe("lazy");
    expect(firstImg!.getAttribute("decoding")).toBe("async");

    act(() => {
      root.unmount();
    });
    expect(firstImg!.hasAttribute("src")).toBe(false);

    root = createRoot(host);
    renderOnce();
    const secondImg = host.querySelector("img");
    expect(secondImg).not.toBeNull();
    expect(secondImg!.getAttribute("src")).toBe(resolved);
  });

  it("appends ?load=N once when retrying a failed local image before falling back to alt text", () => {
    const resolved = "http://localhost:4400/api/file?path=%2Ftmp%2Fretry.png";
    act(() => {
      root.render(
        createElement(MarkdownText, {
          text: "![retry alt](/tmp/retry.png)",
          labels: LABELS,
          pathImages: { resolve: () => resolved },
        }),
      );
    });

    const img = host.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(resolved);

    act(() => {
      img!.dispatchEvent(new Event("error"));
    });
    const retriedSrc = host.querySelector("img")?.getAttribute("src");
    expect(retriedSrc).toMatch(
      /^http:\/\/localhost:4400\/api\/file\?path=%2Ftmp%2Fretry\.png&load=\d+$/u,
    );

    act(() => {
      host.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("retry alt");
  });

  it("does not cache-bust authored remote HTTP(S) images on error", () => {
    act(() => {
      root.render(
        createElement(MarkdownText, {
          text: "![remote alt](https://example.com/pic.png)",
          labels: LABELS,
        }),
      );
    });
    const img = host.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://example.com/pic.png");

    act(() => {
      img!.dispatchEvent(new Event("error"));
    });
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("remote alt");
  });
});
