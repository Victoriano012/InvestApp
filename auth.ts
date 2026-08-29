import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { getOrCreateUser } from "@/lib/db";

declare module "next-auth" {
  interface Session {
    uid?: number;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, user }) {
      // On sign-in, map the Google account to our users row.
      if (user?.email) token.uid = await getOrCreateUser(user.email, user.name ?? null);
      return token;
    },
    session({ session, token }) {
      session.uid = typeof token.uid === "number" ? token.uid : undefined;
      return session;
    },
  },
});

/**
 * DB user id of the request's user, or null when unauthenticated.
 * AUTH_DEV_USER=<email> bypasses Google for local dev/tests.
 */
export async function currentUserId(): Promise<number | null> {
  if (process.env.AUTH_DEV_USER) return getOrCreateUser(process.env.AUTH_DEV_USER, "Dev user");
  const session = await auth();
  return session?.uid ?? null;
}
