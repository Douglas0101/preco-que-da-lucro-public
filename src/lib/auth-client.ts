import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ basePath: "/api/auth" });

export async function changePasswordAndRotate(input: {
  currentPassword: string;
  newPassword: string;
}) {
  return authClient.changePassword({ ...input, revokeOtherSessions: true });
}

export async function globalSignOut(): Promise<void> {
  await authClient.revokeSessions();
  await authClient.signOut();
}
