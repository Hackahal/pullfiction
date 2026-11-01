import { strict as assert } from "node:assert";
import { test } from "node:test";
import { initialLibraryTab, libraryNavigationUrl } from "./library-navigation";

test("landing destination links take precedence over the remembered workspace", () => {
  assert.equal(initialLibraryTab("?page=logs", "workspace"), "logs");
  assert.equal(
    initialLibraryTab("?page=projects&create=1&map=533", "runs"),
    "projects",
  );
  assert.equal(initialLibraryTab("?page=rankings", null), "rankings");
});
test("navigation replaces the explicit destination and consumes plan launch parameters", () => {
  const url = libraryNavigationUrl(
    "https://pullfiction.com/?page=projects&create=1&map=533#raids",
    "logs",
  );
  assert.equal(url, "https://pullfiction.com/?page=logs");
  assert.equal(initialLibraryTab(new URL(url).search, "projects"), "logs");
});
test("ordinary visits resume their page; unknown destinations are not installed", () => {
  assert.equal(initialLibraryTab("", "runs"), "runs");
  assert.equal(initialLibraryTab("?page=unknown", "recent"), "recent");
  assert.equal(initialLibraryTab("?page=unknown", "unknown"), "landing");
  assert.equal(initialLibraryTab("?page=landing", "workspace"), "landing");
});
