import { createSpace, expect, revokeCredentials, settle, test, whereIs } from "./device";

/**
 * Where the app reopens.
 *
 * The rule is "wherever you left it", and every one of these tests is a device
 * being closed and opened again — the only way to tell whether the rule holds,
 * since what carries it across is IndexedDB rather than anything the page can
 * still be asked once it is gone.
 */

/** Both breakpoints render a way out of a space; only one of them is on screen. */
const allSpaces = '[aria-label="All spaces"]:visible';

test("reopens the space the device was last in", async ({ device }) => {
  const first = await device.launch();
  const spaceId = await createSpace(first, "Casa", "Portátil");

  const relaunched = await device.relaunch();

  expect(whereIs(relaunched)).toBe(spaceId);
  await expect(relaunched.getByPlaceholder("Write a message")).toBeVisible();
});

test("leaves the space list behind it, so Back still means all spaces", async ({ device }) => {
  const first = await device.launch();
  await createSpace(first, "Casa", "Portátil");

  const relaunched = await device.relaunch();
  await relaunched.goBack();
  await settle(relaunched);

  expect(whereIs(relaunched)).toBe("spaces");
  await expect(relaunched.getByRole("heading", { name: "Your spaces" })).toBeVisible();
});

test("reopens on the list when that is where the app was left", async ({ device }) => {
  const first = await device.launch();
  await createSpace(first, "Casa", "Portátil");
  // Out of the space by the app's own back arrow, which is what a user has.
  await first.locator(allSpaces).click();
  await settle(first);
  expect(whereIs(first)).toBe("spaces");

  const relaunched = await device.relaunch();

  expect(whereIs(relaunched)).toBe("spaces");
});

test("reopens into the space again once it is opened from the list", async ({ device }) => {
  const first = await device.launch();
  const spaceId = await createSpace(first, "Casa", "Portátil");
  await first.locator(allSpaces).click();
  await settle(first);

  const second = await device.relaunch();
  await second.getByText("Casa").first().click();
  await settle(second);

  const third = await device.relaunch();

  expect(whereIs(third)).toBe(spaceId);
});

test("has nothing to resume on a device with no spaces", async ({ device }) => {
  const page = await device.launch();
  await expect(page.getByText("Create a new space")).toBeVisible();

  const relaunched = await device.relaunch();

  expect(whereIs(relaunched)).toBe("spaces");
  await expect(relaunched.getByText("Create a new space")).toBeVisible();
});

test("does not reopen into a space this device was thrown out of", async ({ device }) => {
  const first = await device.launch();
  const spaceId = await createSpace(first, "Casa", "Portátil");

  await revokeCredentials(first, spaceId);
  const revoked = await device.relaunch();
  // The notice cannot be dismissed: from here the only way on is to leave the
  // space, and that choice has to stay reachable on the next launch.
  await expect(revoked.getByText("This device is no longer linked")).toBeVisible({
    timeout: 30_000,
  });

  const afterwards = await device.relaunch();

  expect(whereIs(afterwards)).toBe("spaces");
  // Still the user's space to leave, or to link this device again from another.
  await expect(afterwards.getByText("Casa")).toBeVisible();
});

/**
 * Two spaces on one device: the case the single-space majority cannot cover,
 * and the one where getting the marker wrong hurts most — a device that resumes
 * into a space it cannot use has every other space behind that same modal.
 */
test("keeps every space reachable from the one it reopens in", async ({ device }) => {
  const first = await device.launch();
  const home = await createSpace(first, "Casa", "Portátil");
  await first.locator(allSpaces).click();
  await settle(first);
  await first.getByRole("button", { name: "New space" }).click();
  const work = await createSpace(first, "Trabajo", "Portátil");
  expect(work).not.toBe(home);

  const relaunched = await device.relaunch();

  expect(whereIs(relaunched)).toBe(work);
  await relaunched.locator(allSpaces).click();
  await settle(relaunched);
  await expect(relaunched.getByText("Casa")).toBeVisible();
  await expect(relaunched.getByText("Trabajo")).toBeVisible();
});
