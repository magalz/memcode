import test from "node:test";
import assert from "node:assert/strict";
import { errorMessage, browserErrorMessage } from "../src/errors";

test("native string rejections remain visible to renderer actions", () => {
  assert.equal(
    errorMessage("External websites are not enabled."),
    "External websites are not enabled.",
  );
  assert.equal(
    errorMessage(new Error("Connection refused")),
    "Connection refused",
  );
  assert.equal(errorMessage({ message: "Story not found" }), "Story not found");
});
test("failed local navigation explains the stopped server without terminal escape noise", () => {
  assert.equal(
    browserErrorMessage(
      "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5000/ Call log: \u001b[2m opening",
    ),
    "This server is not running. Start it in this card’s Terminal, then reload the page.",
  );
  assert.match(
    browserErrorMessage("net::ERR_NAME_NOT_RESOLVED"),
    /address could not be found/,
  );
});
