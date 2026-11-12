import assert from "node:assert/strict";
import test from "node:test";
import { buildTour, cookieStatus, placeTooltip, tourCookieName } from "../src/features/tour/model.ts";

test("tour cookies distinguish users, tour versions, and outcomes", () => {
  const key = tourCookieName("user-one", "farm");
  assert.equal(cookieStatus(`other=1; ${key}=completed`, "user-one", "farm"), "completed");
  assert.equal(cookieStatus(`${key}=dismissed`, "user-two", "farm"), null);
  assert.equal(cookieStatus(`${key}=started`, "user-one", "gettingStarted"), null);
  assert.equal(cookieStatus(`${key}=unknown`, "user-one", "farm"), null);
  assert.notEqual(key, tourCookieName("user-one", "gettingStarted"));
});

test("farm tours adapt to readiness and region without visiting history or invoking actions", () => {
  const scope = { id: "farm-one", region: "IN", verified: false, adviceAvailable: false };
  const steps = buildTour("farm", "/farms/farm-one?tab=soil&mode=rotations", scope, true);
  assert.equal(steps.find((step) => step.id === "preview")?.description, "previewPendingBody");
  assert.ok(steps.every((step) => !step.route.includes("tab=history")));
  assert.ok(steps.every((step) => step.route.includes("mode=rotations")));
  const generic = buildTour("farm", "/farms/farm-one", { ...scope, region: null }, false);
  assert.ok(generic.every((step) => !["preview", "plan", "sprout"].includes(step.id)));
  assert.deepEqual(buildTour("farm", "/", null, true), []);
});

test("tooltip placement stays inside desktop, mobile and offset viewports", () => {
  for (const width of [320, 390, 1365]) {
    const viewport = { left: 0, top: 40, width, height: 600 };
    const size = { width: Math.min(352, width - 24), height: 240 };
    for (const target of [null, { left: width - 80, top: 540, width: 70, height: 50 }, { left: 10, top: 50, width: 140, height: 30 }]) {
      const point = placeTooltip(target, size, viewport);
      assert.ok(point.left >= 12 && point.left + size.width <= width - 12);
      assert.ok(point.top >= 52 && point.top + size.height <= 628);
    }
  }
});

test("mobile tooltips prefer space below the target instead of covering it", () => {
  const target = { left: 16, top: 180, width: 288, height: 50 };
  const point = placeTooltip(target, { width: 296, height: 240 }, { left: 0, top: 0, width: 320, height: 640 });
  assert.equal(point.left, 12);
  assert.ok(point.top >= target.top + target.height + 14);
});