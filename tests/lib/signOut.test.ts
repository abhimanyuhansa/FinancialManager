jest.mock("next-auth/react", () => ({
  signOut: jest.fn(),
}));

import { runSignOutOnce } from "@/components/SignOutButton";

describe("sign-out interaction", () => {
  it("redirects to login and ignores duplicate clicks while the request is pending", async () => {
    let resolveSignOut: (() => void) | undefined;
    const action = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSignOut = resolve;
        }),
    );
    const inProgress = { current: false };

    const firstClick = runSignOutOnce(inProgress, action);
    const duplicateClick = runSignOutOnce(inProgress, action);

    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith({ redirectTo: "/login" });
    await expect(duplicateClick).resolves.toBe(false);

    resolveSignOut?.();
    await expect(firstClick).resolves.toBe(true);
  });
});
