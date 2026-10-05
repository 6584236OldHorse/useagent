import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { backendUpload } from "./backend-fetch";
import { CLIENT_RELEASE_FINGERPRINT, FrontendReleaseMismatchError } from "./release-compat";

// A stand-in for the browser's XMLHttpRequest: records what the upload sends,
// reports two progress events and answers with the headers the script sets.
class FakeXhr {
  static last: FakeXhr | null = null;
  static status = 201;
  static responseHeaders = "content-type: application/json\r\n";
  method = "";
  url = "";
  withCredentials = false;
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = "";
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
    FakeXhr.last = this;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  getAllResponseHeaders() {
    return FakeXhr.responseHeaders;
  }
  send(body: unknown) {
    this.body = body;
    for (const loaded of [5, 10]) {
      this.upload.onprogress?.({ lengthComputable: true, loaded, total: 10 } as ProgressEvent);
    }
    this.status = FakeXhr.status;
    this.responseText = FakeXhr.status === 204 ? "" : '{"upload":{"id":"up-1"}}';
    this.onload?.();
  }
}

const originalXhr = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeEach(() => {
  Object.defineProperty(globalThis, "XMLHttpRequest", { value: FakeXhr, configurable: true, writable: true });
  // The release header is added in the browser only.
  Object.defineProperty(globalThis, "window", {
    value: { sessionStorage: new Map(), setTimeout: () => 0, location: { reload: () => {} } },
    configurable: true,
    writable: true,
  });
  FakeXhr.last = null;
  FakeXhr.status = 201;
  FakeXhr.responseHeaders = "content-type: application/json\r\n";
});

afterEach(() => {
  if (originalXhr) Object.defineProperty(globalThis, "XMLHttpRequest", originalXhr);
  else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("backendUpload", () => {
  test("posts the form with credentials and the release header, reports progress, and returns the response", async () => {
    const progress: number[] = [];
    const form = new FormData();
    form.set("file", new File(["x"], "a.png"));
    const response = await backendUpload("/api/uploads", form, (percent) => progress.push(percent));
    const xhr = FakeXhr.last;
    expect(xhr?.method).toBe("POST");
    expect(xhr?.url).toBe("/api/uploads");
    expect(xhr?.withCredentials).toBe(true);
    expect(xhr?.headers["x-useagent-client-release"]).toBe(CLIENT_RELEASE_FINGERPRINT);
    expect(xhr?.body).toBe(form);
    expect(progress).toEqual([50, 100]);
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ upload: { id: "up-1" } });
  });

  test("a no-content answer resolves without a body", async () => {
    FakeXhr.status = 204;
    const response = await backendUpload("/api/uploads", new FormData(), () => {});
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("a newer server release on a mutating call is refused like backendFetch refuses it", async () => {
    FakeXhr.responseHeaders = "x-useagent-release-fingerprint: run-events-v1:other\r\n";
    await expect(backendUpload("/api/uploads", new FormData(), () => {})).rejects.toBeInstanceOf(
      FrontendReleaseMismatchError,
    );
  });
});
