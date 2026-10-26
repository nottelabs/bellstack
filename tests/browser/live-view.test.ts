import { describe, expect, it } from "vitest";

import { toEmbeddedNotteLiveViewUrl } from "../../lib/browser/live-view.js";

describe("Notte live view URLs", () => {
  it("accepts a signed debugger URL and hides the Notte navigation bar", () => {
    const result = toEmbeddedNotteLiveViewUrl(
      "https://console.notte.cc/static/viewer?jwt=synthetic-scoped-token",
    );
    expect(result).toContain("/static/viewer");
    expect(result).toContain("jwt=synthetic-scoped-token");
  });

  it("rejects the dashboard session URL", () => {
    expect(
      toEmbeddedNotteLiveViewUrl("https://console.notte.cc/sessions/session-id"),
    ).toBeUndefined();
  });

  it("rejects debugger URLs from another host", () => {
    expect(
      toEmbeddedNotteLiveViewUrl(
        "https://example.com/devtools-fullscreen/inspector.html?wss=router.notte.cc%2Fdebug",
      ),
    ).toBeUndefined();
  });
});
