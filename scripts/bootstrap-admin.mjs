import { createClient } from "@supabase/supabase-js";

const required = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CMS_ADMIN_USERNAME", "CMS_ADMIN_PASSWORD", "CMS_ADMIN_NAME"];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  throw new Error(`Variabel wajib belum diatur: ${missing.join(", ")}`);
}

const username = process.env.CMS_ADMIN_USERNAME.trim().toLowerCase();
const password = process.env.CMS_ADMIN_PASSWORD;
const name = process.env.CMS_ADMIN_NAME.trim();
if (!/^[a-zA-Z0-9._-]{3,50}$/.test(username) || password.length < 12 || !name) {
  throw new Error("Username minimal 3 karakter, nama wajib diisi, dan password minimal 12 karakter.");
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const { data: existing, error: lookupError } = await supabase.from("users")
  .select("id").eq("username", username).maybeSingle();
if (lookupError) throw lookupError;
if (existing) throw new Error("Username tersebut sudah ada.");

const { data: authData, error: authError } = await supabase.auth.admin.createUser({
  email: `${username}@cms.invalid`,
  password,
  email_confirm: true,
  user_metadata: { username }
});
if (authError || !authData.user) throw authError ?? new Error("Akun Supabase Auth gagal dibuat.");

const { error } = await supabase.from("users").insert({
  auth_user_id: authData.user.id,
  name,
  username,
  role: "admin",
  team_id: null,
  active: true
});
if (error) {
  await supabase.auth.admin.deleteUser(authData.user.id);
  throw error;
}

console.log(`Akun admin ${username} berhasil dibuat.`);
