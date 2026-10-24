import type { SessionUser } from "./useSession";

/** Mock-mode logins. Real mode uses Person 2's seeded Convex Auth users. */
export const MOCK_USERS: ReadonlyArray<SessionUser & { password: string }> = [
  { email: "demo@tandem.dev", password: "demo1234", name: "Demo Human" },
  { email: "alex@tandem.dev", password: "demo1234", name: "Alex" },
];

export function findMockUser(email: string, password: string): SessionUser | null {
  const match = MOCK_USERS.find(
    (u) => u.email.toLowerCase() === email.trim().toLowerCase() && u.password === password,
  );
  return match ? { email: match.email, name: match.name } : null;
}
