import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type AdminClient = ReturnType<typeof createClient<Database>>;
let client: AdminClient | undefined;

function getClient() {
  if (client) return client;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diatur.");
  }
  client = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return client;
}

export const supabaseAdmin = new Proxy({} as AdminClient, {
  get(_target, property) {
    const target = getClient();
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  }
});
