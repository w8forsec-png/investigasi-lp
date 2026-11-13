import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { errorResponse, json } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { Database } from "@/lib/database.types";
import { createCaseDocx, createCasePdf } from "@/lib/case-report";

export const runtime = "nodejs";

type CmsUser = {
  id: number;
  auth_user_id: string;
  name: string;
  rank_number: string;
  specialty: string;
  role: "admin" | "leader" | "member";
  is_analyst: boolean;
  team_id: number | null;
  username: string;
};

const pageSize = 5;
const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const roleOf = (user: CmsUser) => user.is_analyst ? "analyst" : user.role;
const elevated = (user: CmsUser) => ["admin", "leader", "analyst"].includes(roleOf(user));
const text = (value: unknown, limit: number) => String(value ?? "").trim().slice(0, limit);
const emailFor = (username: string) => `${username.toLowerCase()}@cms.invalid`;
type ManagedRole = "leader" | "analyst" | "member";
type CaseStatus = "Aktif" | "Proses" | "Selesai";
const isManagedRole = (value: string, allowed: ManagedRole[]): value is ManagedRole => allowed.includes(value as ManagedRole);
const isCaseStatus = (value: string): value is CaseStatus => ["Aktif", "Proses", "Selesai"].includes(value);

class InvalidJsonError extends Error {}

async function bodyOf(request: NextRequest) {
  const rawBody = await request.text();
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new InvalidJsonError("Format JSON tidak valid.");
  }
}

async function currentUser() {
  const jar = await cookies();
  let token = jar.get("cms_access")?.value;
  if (!token) return null;
  let { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !authData.user) {
    const refreshToken = jar.get("cms_refresh")?.value;
    if (!refreshToken) return null;
    const authClient = createClient(publicUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: refreshed, error: refreshError } = await authClient.auth.refreshSession({
      refresh_token: refreshToken
    });
    if (refreshError || !refreshed.session || !refreshed.user) return null;
    token = refreshed.session.access_token;
    authData = { user: refreshed.user };
    jar.set("cms_access", token, {
      httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
      path: "/", maxAge: refreshed.session.expires_in
    });
    jar.set("cms_refresh", refreshed.session.refresh_token, {
      httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
      path: "/", maxAge: 30 * 24 * 60 * 60
    });
  }
  const { data, error } = await supabaseAdmin.from("users")
    .select("id,auth_user_id,name,rank_number,specialty,role,is_analyst,team_id,username")
    .eq("auth_user_id", authData.user.id)
    .eq("active", true)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  return data as CmsUser | null;
}

async function audit(userId: number, action: string, caseId: number | null = null, detail = "") {
  const { error } = await supabaseAdmin.from("audit_log").insert({
    actor_id: userId, action, case_id: caseId, detail: detail.slice(0, 250)
  });
  if (error) throw error;
}

async function caseAccess(user: CmsUser, caseId: number, includeArchived = false) {
  const { data: record, error } = await supabaseAdmin.from("cases")
    .select("id,team_id,deleted_at")
    .eq("id", caseId)
    .maybeSingle();
  if (error) throw error;
  if (!record || (record.deleted_at && (!includeArchived || roleOf(user) === "member"))) return null;
  if (roleOf(user) === "admin") return record;
  if (record.team_id !== user.team_id) return null;
  if (["leader", "analyst"].includes(roleOf(user))) return record;
  const { data: membership, error: membershipError } = await supabaseAdmin.from("case_members")
    .select("case_id").eq("case_id", caseId).eq("user_id", user.id).maybeSingle();
  if (membershipError) throw membershipError;
  return membership ? record : null;
}

async function canManageCase(user: CmsUser, caseId: number) {
  if (!elevated(user)) return false;
  const accessible = await caseAccess(user, caseId, true);
  return Boolean(accessible && (roleOf(user) === "admin" || accessible.team_id === user.team_id));
}

function pageData<T>(items: T[], requested: string | null) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number(requested) || 1), totalPages);
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page, per_page: pageSize, total, total_pages: totalPages }
  };
}

async function login(request: NextRequest) {
  const body = await bodyOf(request);
  const username = text(body.username, 50).toLowerCase();
  const password = String(body.password ?? "");
  const { data: account, error: accountError } = await supabaseAdmin.from("users")
    .select("id,auth_user_id,active,deleted_at")
    .eq("username", username).maybeSingle();
  if (accountError) throw accountError;
  if (!account || !account.active || account.deleted_at || !account.auth_user_id) {
    return errorResponse("Nama pengguna atau kata sandi tidak cocok.", 401);
  }
  const authClient = createClient(publicUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data, error } = await authClient.auth.signInWithPassword({
    email: emailFor(username),
    password
  });
  if (error || !data.session) return errorResponse("Nama pengguna atau kata sandi tidak cocok.", 401);
  await audit(account.id, "login");
  const response = json({ ok: true });
  response.cookies.set("cms_access", data.session.access_token, {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: 8 * 60 * 60
  });
  response.cookies.set("cms_refresh", data.session.refresh_token, {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: 30 * 24 * 60 * 60
  });
  return response;
}

async function getTeams(user: CmsUser, includeArchived: boolean) {
  let query = supabaseAdmin.from("teams")
    .select("id,name,description,deleted_at")
    .order("id");
  if (roleOf(user) !== "admin") query = query.eq("id", user.team_id ?? 0);
  if (!includeArchived) query = query.is("deleted_at", null);
  const { data: teams, error } = await query;
  if (error) throw error;
  const results = [];
  for (const team of teams ?? []) {
    const [{ data: people, error: peopleError }, { data: cases, error: casesError }] = await Promise.all([
      supabaseAdmin.from("users").select("name,role,is_analyst,active,deleted_at")
        .eq("team_id", team.id).is("deleted_at", null).eq("active", true),
      supabaseAdmin.from("cases").select("id,status,deleted_at")
        .eq("team_id", team.id).is("deleted_at", null)
    ]);
    if (peopleError) throw peopleError;
    if (casesError) throw casesError;
    const leader = people?.find(person => person.role === "leader");
    results.push({
      ...team, leader: leader?.name ?? null, members: people?.length ?? 0,
      case_count: cases?.length ?? 0,
      active_cases: cases?.filter(item => item.status !== "Selesai").length ?? 0
    });
  }
  return results;
}

async function getCaseDetail(caseId: number, includeArchived: boolean) {
  const { data: item, error } = await supabaseAdmin.from("cases")
    .select("*,teams(name)")
    .eq("id", caseId).maybeSingle();
  if (error) throw error;
  if (!item || (item.deleted_at && !includeArchived)) return null;
  const [profilesResult, reportsResult, entriesResult, membersResult, availableMembersResult] = await Promise.all([
    (async () => {
      let query = supabaseAdmin.from("profiles").select("*").eq("case_id", caseId).order("id", { ascending: false });
      if (!includeArchived) query = query.is("deleted_at", null);
      return query;
    })(),
    (async () => {
      let query = supabaseAdmin.from("field_reports").select("*,users!field_reports_created_by_fkey(name)")
        .eq("case_id", caseId).order("id", { ascending: false });
      if (!includeArchived) query = query.is("deleted_at", null);
      return query;
    })(),
    (async () => {
      let query = supabaseAdmin.from("technical_entries")
        .select("*,users!technical_entries_created_by_fkey(name),field_reports(title)")
        .eq("case_id", caseId).order("id", { ascending: false });
      if (!includeArchived) query = query.is("deleted_at", null);
      return query;
    })(),
    supabaseAdmin.from("case_members").select("duty,users(id,name,rank_number,specialty)")
      .eq("case_id", caseId),
    supabaseAdmin.from("users")
      .select("id,name,rank_number,specialty,role,is_analyst")
      .eq("team_id", item.team_id).eq("active", true).is("deleted_at", null).order("name")
  ]);
  if (profilesResult.error) throw profilesResult.error;
  if (reportsResult.error) throw reportsResult.error;
  if (entriesResult.error) throw entriesResult.error;
  if (membersResult.error) throw membersResult.error;
  if (availableMembersResult.error) throw availableMembersResult.error;
  const parentIds = [...new Set((entriesResult.data ?? [])
    .map(entry => entry.parent_entry_id)
    .filter((id): id is number => id !== null))];
  const parentTitles = new Map<number, string>();
  if (parentIds.length) {
    const { data: parents, error: parentsError } = await supabaseAdmin.from("technical_entries")
      .select("id,title").in("id", parentIds);
    if (parentsError) throw parentsError;
    for (const parent of parents ?? []) parentTitles.set(parent.id, parent.title);
  }
  const team = Array.isArray(item.teams) ? item.teams[0] : item.teams;
  return {
    case: { ...item, team_name: team?.name ?? "" },
    profiles: profilesResult.data ?? [],
    field_reports: (reportsResult.data ?? []).map(report => ({
      ...report, author: report.users?.name ?? "", users: undefined
    })),
    technical_entries: (entriesResult.data ?? []).map(entry => ({
      ...entry, author: entry.users?.name ?? "", source_report_title: entry.field_reports?.title ?? "",
      previous_title: entry.parent_entry_id ? parentTitles.get(entry.parent_entry_id) ?? "" : "",
      users: undefined, field_reports: undefined
    })),
    members: (membersResult.data ?? []).map(member => ({
      ...(Array.isArray(member.users) ? member.users[0] : member.users), duty: member.duty
    })),
    available_members: availableMembersResult.data ?? []
  };
}

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    const user = await currentUser();
    if (!user) return errorResponse("Silakan masuk terlebih dahulu.", 401);
    const params = request.nextUrl.searchParams;
    const includeArchived = params.get("include_archived") === "1";

    if (path[0] === "session") {
      const { data: team, error } = user.team_id
        ? await supabaseAdmin.from("teams").select("name").eq("id", user.team_id).maybeSingle()
        : { data: null, error: null };
      if (error) throw error;
      return json({ user: { ...user, role: roleOf(user), team_name: team?.name ?? "Semua Tim" } });
    }

    if (path[0] === "dashboard") {
      let query = supabaseAdmin.from("cases").select("*,teams(name)").is("deleted_at", null).order("created_at", { ascending: false });
      if (roleOf(user) !== "admin") query = query.eq("team_id", user.team_id ?? 0);
      else if (params.get("team")) query = query.eq("team_id", Number(params.get("team")));
      const { data: cases, error } = await query;
      if (error) throw error;
      const visible = [];
      let profileCount = 0;
      let technicalCount = 0;
      for (const item of cases ?? []) {
        if (roleOf(user) === "member" && !(await caseAccess(user, item.id))) continue;
        const [profiles, entries] = await Promise.all([
          supabaseAdmin.from("profiles").select("id", { count: "exact", head: true }).eq("case_id", item.id).is("deleted_at", null),
          supabaseAdmin.from("technical_entries").select("id", { count: "exact", head: true }).eq("case_id", item.id).is("deleted_at", null)
        ]);
        if (profiles.error) throw profiles.error;
        if (entries.error) throw entries.error;
        profileCount += profiles.count ?? 0;
        technicalCount += entries.count ?? 0;
        const team = Array.isArray(item.teams) ? item.teams[0] : item.teams;
        visible.push({ ...item, team_name: team?.name ?? "" });
      }
      const teams = roleOf(user) === "admin" ? await getTeams(user, false) : [];
      return json({
        totals: {
          cases: visible.length, active: visible.filter(item => item.status !== "Selesai").length,
          profiles: profileCount, technical_entries: technicalCount
        },
        casesByStatus: visible.reduce<Record<string, number>>((acc, item) => {
          acc[item.status] = (acc[item.status] ?? 0) + 1; return acc;
        }, {}),
        teams,
        cases: visible.slice(0, 8)
      });
    }

    if (path[0] === "teams" && path.length === 1) {
      if (!elevated(user)) return errorResponse("Akses hanya untuk pimpinan, Katim, atau Tim Analis.", 403);
      if (includeArchived && roleOf(user) !== "admin") return errorResponse("Hanya pimpinan yang dapat melihat arsip tim.", 403);
      return json({ teams: await getTeams(user, includeArchived) });
    }

    if (path[0] === "teams" && path[2] === "users") {
      if (!elevated(user)) return errorResponse("Akses hanya untuk pimpinan, Katim, atau Tim Analis.", 403);
      const teamId = Number(path[1]);
      if (roleOf(user) !== "admin" && teamId !== user.team_id) return errorResponse("Tim tidak ditemukan.", 404);
      if (includeArchived && roleOf(user) !== "admin") return errorResponse("Hanya pimpinan yang dapat melihat personel yang diarsipkan.", 403);
      let query = supabaseAdmin.from("users")
        .select("id,name,username,rank_number,specialty,role,is_analyst,active,deleted_at")
        .eq("team_id", teamId).neq("role", "admin");
      if (!includeArchived) query = query.is("deleted_at", null);
      const { data, error } = await query;
      if (error) throw error;
      const users = (data ?? []).map(person => ({ ...person, role: person.is_analyst ? "analyst" : person.role }))
        .sort((a, b) => (a.role === "leader" ? 0 : a.role === "analyst" ? 1 : 2) - (b.role === "leader" ? 0 : b.role === "analyst" ? 1 : 2) || a.name.localeCompare(b.name));
      const result = pageData(users, params.get("page"));
      return json({ users: result.items, pagination: result.pagination });
    }

    if (path[0] === "cases" && path.length === 1) {
      if (includeArchived && roleOf(user) === "member") return errorResponse("Hanya pimpinan, Katim, atau Tim Analis yang dapat melihat arsip.", 403);
      let query = supabaseAdmin.from("cases").select("*,teams(name)").order("created_at", { ascending: false });
      if (!includeArchived) query = query.is("deleted_at", null);
      if (roleOf(user) !== "admin") query = query.eq("team_id", user.team_id ?? 0);
      const { data, error } = await query;
      if (error) throw error;
      const search = (params.get("q") ?? "").trim().toLowerCase();
      const visible = [];
      for (const item of data ?? []) {
        if (roleOf(user) === "member" && !(await caseAccess(user, item.id, includeArchived))) continue;
        const team = Array.isArray(item.teams) ? item.teams[0] : item.teams;
        if (search && !`${item.lp_number} ${item.title} ${team?.name ?? ""}`.toLowerCase().includes(search)) continue;
        const [profiles, entries] = await Promise.all([
          supabaseAdmin.from("profiles").select("id", { count: "exact", head: true }).eq("case_id", item.id).is("deleted_at", null),
          supabaseAdmin.from("technical_entries").select("id", { count: "exact", head: true }).eq("case_id", item.id).is("deleted_at", null)
        ]);
        if (profiles.error) throw profiles.error;
        if (entries.error) throw entries.error;
        visible.push({
          ...item, team_name: team?.name ?? "", profile_count: profiles.count ?? 0,
          technical_count: entries.count ?? 0
        });
      }
      const result = pageData(visible, params.get("page"));
      return json({ cases: result.items, pagination: result.pagination });
    }

    if (path[0] === "cases" && path.length === 3 && path[2] === "report") {
      const caseId = Number(path[1]);
      if (!Number.isSafeInteger(caseId) || caseId < 1) return errorResponse("Perkara tidak ditemukan.", 404);
      if (!await caseAccess(user, caseId)) return errorResponse("Perkara tidak ditemukan.", 404);
      const report = await getCaseDetail(caseId, false);
      if (!report) return errorResponse("Perkara tidak ditemukan.", 404);
      const format = params.get("format");
      if (format !== "pdf" && format !== "docx") {
        return errorResponse("Pilih format laporan PDF atau DOCX.", 400);
      }

      const baseName = `laporan-${report.case.lp_number.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
      const file = format === "pdf" ? await createCasePdf(report) : await createCaseDocx(report);
      const contentType = format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      return new NextResponse(new Uint8Array(file), {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${baseName}.${format}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    if (path[0] === "cases" && path.length === 2) {
      const caseId = Number(path[1]);
      if (!await caseAccess(user, caseId, includeArchived)) return errorResponse("Perkara tidak ditemukan.", 404);
      const detail = await getCaseDetail(caseId, includeArchived);
      return detail ? json(detail) : errorResponse("Perkara tidak ditemukan.", 404);
    }

    return errorResponse("Rute tidak ditemukan.", 404);
  } catch (error) {
    console.error("GET /api error:", error);
    return errorResponse("Terjadi kesalahan pada server.", 500);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    if (path[0] === "login") return await login(request);
    if (path[0] === "logout") {
      const response = json({ ok: true });
      response.cookies.delete("cms_access");
      response.cookies.delete("cms_refresh");
      return response;
    }
    const user = await currentUser();
    if (!user) return errorResponse("Silakan masuk terlebih dahulu.", 401);
    const body = await bodyOf(request);

    if (path[0] === "users" && path.length === 1) {
      if (!elevated(user)) return errorResponse("Hanya pimpinan, Katim, atau Tim Analis yang dapat membuat akun.", 403);
      const name = text(body.name, 100);
      const username = text(body.username, 50).toLowerCase();
      const password = String(body.password ?? "");
      const requestedRole = String(body.role ?? "");
      const teamId = Number(body.team_id);
      const allowedRoles: ManagedRole[] = roleOf(user) === "admin" ? ["leader", "analyst", "member"] : ["analyst", "member"];
      if (!name || !/^[a-zA-Z0-9._-]{3,50}$/.test(username) || password.length < 12 || !isManagedRole(requestedRole, allowedRoles)) {
        return errorResponse("Nama, nama pengguna (3–50 karakter), kata sandi minimal 12 karakter, dan peran yang valid wajib diisi.");
      }
      if (roleOf(user) !== "admin" && teamId !== user.team_id) return errorResponse("Katim dan Tim Analis hanya dapat menambah akun di timnya sendiri.", 403);
      const { data: team, error: teamError } = await supabaseAdmin.from("teams").select("id")
        .eq("id", teamId).is("deleted_at", null).maybeSingle();
      if (teamError) throw teamError;
      if (!team) return errorResponse("Tim aktif tidak ditemukan.");
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: emailFor(username), password, email_confirm: true, user_metadata: { username }
      });
      if (authError || !authData.user) {
        if (authError?.message.toLowerCase().includes("already")) return errorResponse("Nama pengguna sudah digunakan.", 409);
        throw authError ?? new Error("Akun autentikasi gagal dibuat.");
      }
      const { data: account, error } = await supabaseAdmin.from("users").insert({
        auth_user_id: authData.user.id, name, username,
        rank_number: text(body.rank_number, 80), specialty: text(body.specialty, 100),
        role: requestedRole === "analyst" ? "member" : requestedRole,
        is_analyst: requestedRole === "analyst", team_id: teamId
      }).select("id").single();
      if (error) {
        await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
        if (error.code === "23505") return errorResponse("Nama pengguna sudah digunakan.", 409);
        throw error;
      }
      await audit(user.id, "user.created", null, `user:${account.id}`);
      return json({ id: account.id }, 201);
    }

    if (path[0] === "cases" && path.length === 1) {
      if (!elevated(user)) return errorResponse("Hanya pimpinan, Katim, atau Tim Analis yang dapat membuat perkara.", 403);
      const lpNumber = text(body.lp_number, 80);
      const title = text(body.title, 120);
      const reportedAt = String(body.reported_at ?? "");
      const teamId = roleOf(user) === "admin" ? Number(body.team_id) : Number(user.team_id);
      const victim = {
        name: text(body.victim_name, 100), nik: text(body.victim_nik, 32),
        address: text(body.victim_address, 300), phone: text(body.victim_phone, 32)
      };
      const hasVictimDetails = Object.values(victim).some(Boolean);
      if (!lpNumber || !title || !/^\d{4}-\d{2}-\d{2}$/.test(reportedAt)) return errorResponse("Nomor LP, judul, dan tanggal LP wajib diisi.");
      if (hasVictimDetails && !victim.name) return errorResponse("Nama wajib diisi jika data korban dicantumkan.");
      if (roleOf(user) !== "admin" && Number(body.team_id) !== user.team_id) return errorResponse("Katim dan Tim Analis hanya dapat membuat perkara untuk timnya sendiri.", 403);
      const { data: team, error: teamError } = await supabaseAdmin.from("teams").select("id")
        .eq("id", teamId).is("deleted_at", null).maybeSingle();
      if (teamError) throw teamError;
      if (!team) return errorResponse("Tim aktif tidak ditemukan.");
      const { data: caseId, error } = await supabaseAdmin.rpc("create_case_with_victim", {
        p_lp_number: lpNumber, p_title: title, p_reported_at: reportedAt,
        p_statute: text(body.statute, 150), p_location: text(body.location, 300),
        p_team_id: teamId, p_actor_id: user.id, p_victim_name: victim.name,
        p_victim_nik: victim.nik, p_victim_address: victim.address, p_victim_phone: victim.phone
      });
      if (error) {
        if (error.code === "23505") return errorResponse("Nomor LP sudah terdaftar.", 409);
        throw error;
      }
      if (!caseId) throw new Error("Perkara gagal dibuat.");
      return json({ id: caseId }, 201);
    }

    const match = path[0] === "cases" && path[1] ? Number(path[1]) : NaN;
    if (Number.isFinite(match) && path.length === 3 && ["profiles", "field-reports", "technical"].includes(path[2])) {
      if (!await caseAccess(user, match)) return errorResponse("Perkara tidak ditemukan.", 404);
      const table = path[2] === "profiles" ? "profiles" : path[2] === "field-reports" ? "field_reports" : "technical_entries";
      const common = { case_id: match, created_by: user.id };
      let values: Record<string, unknown>;
      if (path[2] === "profiles") {
        const profileType = String(body.profile_type ?? "Terduga");
        const name = text(body.name, 100);
        if (!name || !["Korban", "Terduga"].includes(profileType)) return errorResponse("Jenis profil dan nama yang valid wajib diisi.");
        values = { ...common, profile_type: profileType, name, alias: text(body.alias, 100), nik: text(body.nik, 32), address: text(body.address, 300), phone: text(body.phone, 32), role_in_case: text(body.role_in_case, 80), notes: text(body.notes, 1000) };
      } else if (path[2] === "field-reports") {
        const title = text(body.title, 120), details = text(body.details, 3000);
        if (!title || !details) return errorResponse("Judul dan rincian informasi lapangan wajib diisi.");
        values = { ...common, source_unit: text(body.source_unit || "Tim Lapangan", 100), title, reference: text(body.reference, 150), details };
      } else {
        const category = text(body.category, 80), title = text(body.title, 120), findings = text(body.findings, 3000);
        const progress = String(body.progress_status || "Analisis awal");
        if (!category || !title || !findings) return errorResponse("Kategori, judul, dan hasil analisis wajib diisi.");
        if (!["Analisis awal", "Tindak lanjut", "Selesai"].includes(progress)) return errorResponse("Status perkembangan analisis tidak valid.");
        const fieldReportId = body.field_report_id ? Number(body.field_report_id) : null;
        const parentEntryId = body.parent_entry_id ? Number(body.parent_entry_id) : null;
        if (fieldReportId) {
          const { data: report, error: reportError } = await supabaseAdmin.from("field_reports")
            .select("id").eq("id", fieldReportId).eq("case_id", match).is("deleted_at", null).maybeSingle();
          if (reportError) throw reportError;
          if (!report) return errorResponse("Sumber informasi lapangan tidak ditemukan pada perkara ini.");
        }
        if (parentEntryId) {
          const { data: parent, error: parentError } = await supabaseAdmin.from("technical_entries")
            .select("id").eq("id", parentEntryId).eq("case_id", match).is("deleted_at", null).maybeSingle();
          if (parentError) throw parentError;
          if (!parent) return errorResponse("Analisis sebelumnya tidak ditemukan pada perkara ini.");
        }
        values = {
          ...common, category, title, target_ref: text(body.target_ref, 120), findings,
          progress_status: progress,
          field_report_id: fieldReportId, parent_entry_id: parentEntryId
        };
      }
      const { data: record, error } = await supabaseAdmin.from(table).insert(values).select("id").single();
      if (error) throw error;
      await audit(user.id, `${table}.created`, match, `record:${record.id}`);
      return json({ id: record.id }, 201);
    }

    return errorResponse("Rute tidak ditemukan.", 404);
  } catch (error) {
    if (error instanceof InvalidJsonError) return errorResponse(error.message, 400);
    console.error("POST /api error:", error);
    return errorResponse("Terjadi kesalahan pada server.", 500);
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    const user = await currentUser();
    if (!user) return errorResponse("Silakan masuk terlebih dahulu.", 401);

    if (path[0] === "teams" && path[1]) {
      if (roleOf(user) !== "admin") return errorResponse("Akses hanya untuk pimpinan.", 403);
      const teamId = Number(path[1]);
      if (path[2] === "restore") {
        const { error } = await supabaseAdmin.from("teams").update({ deleted_at: null }).eq("id", teamId);
        if (error) throw error;
        await audit(user.id, "team.restored", null, `team:${teamId}`);
        return json({ ok: true });
      }
      const body = await bodyOf(request);
      const name = text(body.name, 80);
      if (!name) return errorResponse("Nama tim wajib diisi.");
      const { error } = await supabaseAdmin.from("teams").update({
        name, description: text(body.description, 160)
      }).eq("id", teamId);
      if (error) {
        if (error.code === "23505") return errorResponse("Nama tim sudah digunakan.", 409);
        throw error;
      }
      await audit(user.id, "team.updated", null, `team:${teamId}`);
      return json({ ok: true });
    }

    if (path[0] === "users" && path[1]) {
      if (!elevated(user)) return errorResponse("Akses hanya untuk pimpinan, Katim, atau Tim Analis.", 403);
      const id = Number(path[1]);
      const { data: target, error: targetError } = await supabaseAdmin.from("users")
        .select("id,role,is_analyst,team_id").eq("id", id).neq("role", "admin").maybeSingle();
      if (targetError) throw targetError;
      if (!target) return errorResponse("Personel tidak ditemukan.", 404);
      const targetRole = target.is_analyst ? "analyst" : target.role;
      if (roleOf(user) !== "admin" && (target.team_id !== user.team_id || targetRole === "leader")) return errorResponse("Katim dan Tim Analis hanya dapat mengelola anggota atau analis di timnya.", 403);
      if (path[2] === "restore") {
        if (target.team_id === null) return errorResponse("Tim personel tidak ditemukan.", 404);
        const { data: team, error: teamError } = await supabaseAdmin.from("teams")
          .select("deleted_at").eq("id", target.team_id).maybeSingle();
        if (teamError) throw teamError;
        if (team?.deleted_at) return errorResponse("Pulihkan tim terlebih dahulu.", 409);
        const { error } = await supabaseAdmin.from("users").update({ deleted_at: null, active: true }).eq("id", id);
        if (error) throw error;
        await audit(user.id, "user.restored", null, `user:${id}`);
        return json({ ok: true });
      }
      const body = await bodyOf(request);
      const name = text(body.name, 100);
      const requestedRole = String(body.role ?? targetRole);
      const allowedRoles: ManagedRole[] = roleOf(user) === "admin" ? ["leader", "analyst", "member"] : ["analyst", "member"];
      if (!name || !isManagedRole(requestedRole, allowedRoles)) return errorResponse("Nama dan peran personel yang valid wajib diisi.");
      const { error } = await supabaseAdmin.from("users").update({
        name, rank_number: text(body.rank_number, 80), specialty: text(body.specialty, 100),
        role: requestedRole === "analyst" ? "member" : requestedRole,
        is_analyst: requestedRole === "analyst"
      }).eq("id", id);
      if (error) throw error;
      await audit(user.id, "user.updated", null, `user:${id}`);
      return json({ ok: true });
    }

    if (path[0] === "cases" && path[1]) {
      const caseId = Number(path[1]);
      const isRestore = path[2] === "restore";
      const itemId = path[3] ? Number(path[3]) : null;
      const resource = path[2];
      if (!await caseAccess(user, caseId, isRestore || Boolean(itemId))) return errorResponse("Perkara tidak ditemukan.", 404);
      if (isRestore) {
        if (!await canManageCase(user, caseId)) return errorResponse("Hanya pimpinan atau kepala tim yang dapat memulihkan perkara.", 403);
        const { data: record, error: readError } = await supabaseAdmin.from("cases").select("teams(deleted_at)").eq("id", caseId).single();
        if (readError) throw readError;
        const team = Array.isArray(record.teams) ? record.teams[0] : record.teams;
        if (team?.deleted_at) return errorResponse("Pulihkan tim perkara terlebih dahulu.", 409);
        const { error } = await supabaseAdmin.from("cases").update({ deleted_at: null }).eq("id", caseId);
        if (error) throw error;
        await audit(user.id, "case.restored", caseId);
        return json({ ok: true });
      }
      if (!resource) {
        if (!await canManageCase(user, caseId)) return errorResponse("Hanya pimpinan atau kepala tim yang dapat mengubah data perkara.", 403);
        const body = await bodyOf(request);
        const lpNumber = text(body.lp_number, 80), title = text(body.title, 120);
        const reportedAt = String(body.reported_at ?? ""), status = String(body.status ?? "");
        if (!lpNumber || !title || !/^\d{4}-\d{2}-\d{2}$/.test(reportedAt) || !isCaseStatus(status)) return errorResponse("Nomor LP, judul, tanggal, dan status perkara yang valid wajib diisi.");
        const { error } = await supabaseAdmin.from("cases").update({
          lp_number: lpNumber, title, reported_at: reportedAt, status,
          statute: text(body.statute, 150), location: text(body.location, 300)
        }).eq("id", caseId);
        if (error) {
          if (error.code === "23505") return errorResponse("Nomor LP sudah terdaftar.", 409);
          throw error;
        }
        await audit(user.id, "case.updated", caseId, lpNumber);
        return json({ ok: true });
      }
      if (resource === "assignments" && path.length === 3) {
        if (!elevated(user)) return errorResponse("Tidak memiliki hak mengatur penugasan.", 403);
        const body = await bodyOf(request);
        const { data: caseTeam, error: caseError } = await supabaseAdmin.from("cases").select("team_id").eq("id", caseId).single();
        if (caseError) throw caseError;
        const { data: member, error: memberError } = await supabaseAdmin.from("users").select("id")
          .eq("id", Number(body.user_id)).eq("team_id", caseTeam.team_id).eq("active", true).is("deleted_at", null).maybeSingle();
        if (memberError) throw memberError;
        if (!member) return errorResponse("Personel harus aktif dan berasal dari tim perkara ini.");
        const { error } = await supabaseAdmin.from("case_members").upsert({
          case_id: caseId, user_id: member.id, duty: text(body.duty, 100)
        });
        if (error) throw error;
        await audit(user.id, "assignment.updated", caseId, `user:${member.id}`);
        return json({ ok: true });
      }
      if (itemId && ["profiles", "field-reports", "technical"].includes(resource)) {
        const table = resource === "profiles" ? "profiles" : resource === "field-reports" ? "field_reports" : "technical_entries";
        const fieldList = resource === "profiles"
          ? ["profile_type", "name", "alias", "nik", "address", "phone", "role_in_case", "notes"]
          : resource === "field-reports" ? ["source_unit", "title", "reference", "details"]
            : ["category", "title", "target_ref", "progress_status", "findings"];
        const { data: current, error: currentError } = await supabaseAdmin.from(table).select("*")
          .eq("id", itemId).eq("case_id", caseId).maybeSingle();
        if (currentError) throw currentError;
        if (!current) return errorResponse("Catatan tidak ditemukan.", 404);
        if (path[4] === "restore") {
          const { error } = await supabaseAdmin.from(table).update({ deleted_at: null }).eq("id", itemId).eq("case_id", caseId);
          if (error) throw error;
          await audit(user.id, `${table}.restored`, caseId, `record:${itemId}`);
          return json({ ok: true });
        }
        const body = await bodyOf(request);
        const currentFields = current as Record<string, unknown>;
        const values = Object.fromEntries(fieldList.map(field => [field, text(body[field] ?? currentFields[field], field === "notes" || field === "details" || field === "findings" ? 3000 : 300)]));
        if (!values.name && resource === "profiles" || !values.title && resource !== "profiles" || !values.category && resource === "technical" || !values.findings && resource === "technical") return errorResponse("Lengkapi semua kolom wajib.");
        if (resource === "profiles" && !["Korban", "Terduga"].includes(String(values.profile_type))) return errorResponse("Jenis profil harus Korban atau Terduga.");
        if (resource === "technical" && !["Analisis awal", "Tindak lanjut", "Selesai"].includes(String(values.progress_status))) return errorResponse("Status perkembangan analisis tidak valid.");
        const updateResult = resource === "profiles"
          ? await supabaseAdmin.from("profiles").update(values as Database["public"]["Tables"]["profiles"]["Update"]).eq("id", itemId).eq("case_id", caseId)
          : resource === "field-reports"
            ? await supabaseAdmin.from("field_reports").update(values as Database["public"]["Tables"]["field_reports"]["Update"]).eq("id", itemId).eq("case_id", caseId)
            : await supabaseAdmin.from("technical_entries").update(values as Database["public"]["Tables"]["technical_entries"]["Update"]).eq("id", itemId).eq("case_id", caseId);
        const { error } = updateResult;
        if (error) throw error;
        await audit(user.id, `${table}.updated`, caseId, `record:${itemId}`);
        return json({ ok: true });
      }
    }
    return errorResponse("Rute tidak ditemukan.", 404);
  } catch (error) {
    if (error instanceof InvalidJsonError) return errorResponse(error.message, 400);
    console.error("PATCH /api error:", error);
    return errorResponse("Terjadi kesalahan pada server.", 500);
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    const user = await currentUser();
    if (!user) return errorResponse("Silakan masuk terlebih dahulu.", 401);
    if (path[0] === "teams" && path[1]) {
      if (roleOf(user) !== "admin") return errorResponse("Akses hanya untuk pimpinan.", 403);
      const teamId = Number(path[1]);
      const { error } = await supabaseAdmin.rpc("archive_team", { target_team_id: teamId, actor_id: user.id });
      if (error?.code === "23514") return errorResponse("Arsipkan seluruh perkara tim terlebih dahulu.", 409);
      if (error?.code === "P0002") return errorResponse("Tim tidak ditemukan.", 404);
      if (error) throw error;
      return json({ ok: true });
    }
    if (path[0] === "users" && path[1]) {
      if (!elevated(user)) return errorResponse("Hak akses tidak memadai.", 403);
      const id = Number(path[1]);
      if (id === user.id) return errorResponse("Anda tidak dapat mengarsipkan akun yang sedang digunakan.", 409);
      const { data: target, error: targetError } = await supabaseAdmin.from("users")
        .select("id,role,is_analyst,team_id").eq("id", id).neq("role", "admin").maybeSingle();
      if (targetError) throw targetError;
      if (!target) return errorResponse("Personel tidak ditemukan.", 404);
      if (roleOf(user) !== "admin" && (target.team_id !== user.team_id || target.role === "leader")) return errorResponse("Katim dan Tim Analis hanya dapat mengelola anggota atau analis di timnya.", 403);
      const { error } = await supabaseAdmin.from("users").update({ active: false, deleted_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
      await audit(user.id, "user.archived", null, `user:${id}`);
      return json({ ok: true });
    }
    if (path[0] === "cases" && path[1]) {
      const caseId = Number(path[1]);
      if (path.length === 2) {
        if (!await canManageCase(user, caseId)) return errorResponse("Hanya pimpinan atau kepala tim yang dapat mengarsipkan perkara.", 403);
        const { error } = await supabaseAdmin.from("cases").update({ deleted_at: new Date().toISOString() }).eq("id", caseId);
        if (error) throw error;
        await audit(user.id, "case.archived", caseId);
        return json({ ok: true });
      }
      const resource = path[2], itemId = Number(path[3]);
      const table = resource === "profiles" ? "profiles" : resource === "field-reports" ? "field_reports" : resource === "technical" ? "technical_entries" : null;
      if (!table || !itemId || !await caseAccess(user, caseId)) return errorResponse("Catatan tidak ditemukan.", 404);
      const { error } = await supabaseAdmin.from(table)
        .update({ deleted_at: new Date().toISOString() }).eq("id", itemId).eq("case_id", caseId);
      if (error) throw error;
      await audit(user.id, `${table}.archived`, caseId, `record:${itemId}`);
      return json({ ok: true });
    }
    return errorResponse("Rute tidak ditemukan.", 404);
  } catch (error) {
    console.error("DELETE /api error:", error);
    return errorResponse("Terjadi kesalahan pada server.", 500);
  }
}
