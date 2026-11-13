const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  user: null, dashboard: null, cases: [], casePagination: null, casePage: 1, caseShowArchived: false,
  teams: [], teamPages: {}, teamShowArchived: false, activeView: "overview", workflow: null,
  peopleByTeam: {}, caseDetail: null, openCaseId: null, detailArchived: false,
  detailPages: { profiles: 1, field_reports: 1, technical_entries: 1 }, editor: null
};

const roleLabels = { admin: "Pimpinan / Admin", leader: "Kepala Tim", analyst: "Tim Analis", member: "Anggota Tim" };
const statusClass = status => status === "Selesai" ? "done" : status === "Proses" ? "process" : "active";
const progressClass = status => status === "Selesai" ? "done" : status === "Tindak lanjut" ? "process" : "active";
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const dateLabel = value => value ? new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value.slice(0, 10)}T00:00:00`)) : "—";

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Permintaan gagal.");
  return result;
}

async function downloadCaseReport(caseId, format) {
  const response = await fetch(`/api/cases/${caseId}/report?format=${format}`);
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.error || "Laporan gagal dibuat.");
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `laporan-perkara.${format}`;
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function showLogin() {
  $("#login-view").hidden = false;
  $("#app-view").hidden = true;
}

function showApp() {
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
}

function setView(name) {
  state.activeView = name;
  $$(".view").forEach(view => { view.hidden = view.id !== `${name}-view`; });
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  $("#breadcrumb-current").textContent = name === "overview" ? "Ringkasan" : name === "cases" ? "Daftar perkara" : "Tim & personel";
}

async function loadApp() {
  const { user } = await api("/api/session");
  state.user = user;
  showApp();
  $("#user-name").textContent = user.name;
  $("#user-role").textContent = `${roleLabels[user.role]}${user.team_name !== "Semua Tim" ? ` · ${user.team_name}` : ""}`;
  $("#workspace-name").textContent = user.team_name;
  $("#user-avatar").textContent = user.name.split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase();
  const canManageTeamUsers = ["admin", "leader", "analyst"].includes(user.role);
  $("#teams-nav").hidden = !canManageTeamUsers;
  $("#team-summary-panel").hidden = user.role !== "admin";
  $("#team-filter").hidden = user.role !== "admin";
  $("#new-case-button").hidden = !["admin", "leader", "analyst"].includes(user.role);
  $("#case-archive-filter").hidden = user.role === "member";
  $("#team-show-archived").closest("label").hidden = user.role !== "admin";
  $("#add-personnel-button").hidden = true;
  $("#case-team-field").hidden = user.role !== "admin";
  $("#welcome-eyebrow").textContent = user.role === "admin" ? "PUSAT KENDALI · PIMPINAN" : `${user.team_name.toUpperCase()} · RUANG KERJA`;
  await Promise.all([loadDashboard(), loadCases()]);
  if (canManageTeamUsers) await loadTeams();
  $("#add-personnel-button").hidden = !canManageTeamUsers;
}

async function loadDashboard() {
  const filter = $("#team-select")?.value;
  const data = await api(`/api/dashboard${filter ? `?team=${encodeURIComponent(filter)}` : ""}`);
  state.dashboard = data;
  $("#metric-active").textContent = data.totals.active;
  $("#metric-case-total").textContent = `${data.totals.cases} perkara keseluruhan`;
  $("#metric-profiles").textContent = data.totals.profiles;
  $("#metric-technical").textContent = data.totals.technical_entries;
  $("#metric-teams").textContent = state.user.role === "admin" ? data.teams.length : "1";
  $("#nav-case-count").textContent = data.totals.cases;
  $("#recent-cases").innerHTML = data.cases.length ? data.cases.map(item => `
    <tr data-case-id="${item.id}" data-case-archived="${Boolean(item.deleted_at)}" class="clickable-row">
      <td><strong>${esc(item.title)}</strong><small>${esc(item.lp_number)}</small></td>
      <td>${esc(item.team_name)}</td><td>${dateLabel(item.reported_at)}</td>
      <td><span class="status-pill ${statusClass(item.status)}"><i></i>${esc(item.status)}</span></td>
    </tr>`).join("") : `<tr><td colspan="4" class="empty-state">Belum ada perkara pada ruang kerja ini.</td></tr>`;
  $("#team-summary").innerHTML = data.teams.map(team => `
    <div class="team-row"><div class="team-emblem ${team.id === 1 ? "emblem-blue" : "emblem-violet"}">${esc(team.name.slice(-1))}</div>
      <div class="team-row-main"><div><strong>${esc(team.name)}</strong><span>${team.active_count || 0} perkara aktif</span></div>
        <div class="progress-track"><span class="${team.id === 1 ? "bar-blue" : "bar-violet"}" style="width:${Math.min(100, (team.active_count || 0) * 18 + 12)}%"></span></div></div>
      <span class="team-total">${team.case_count || 0}</span></div>`).join("");
}

async function loadCases(page = state.casePage) {
  state.casePage = page;
  const params = new URLSearchParams({ page: String(page), q: $("#case-search").value.trim() });
  if (state.caseShowArchived) params.set("include_archived", "1");
  const { cases, pagination } = await api(`/api/cases?${params}`);
  state.cases = cases;
  state.casePagination = pagination;
  renderCases();
}

function renderCases() {
  const filtered = state.cases;
  const canManageCases = ["admin", "leader", "analyst"].includes(state.user.role);
  $("#case-list-count").textContent = `${state.casePagination?.total || 0} perkara`;
  $("#all-cases").innerHTML = filtered.length ? filtered.map(item => `
    <tr data-case-id="${item.id}" data-case-archived="${Boolean(item.deleted_at)}" class="clickable-row">
      <td><strong>${esc(item.lp_number)}</strong><small>${esc(item.title)}</small></td><td>${esc(item.team_name)}</td>
      <td>${dateLabel(item.reported_at)}</td><td>${item.profile_count}</td><td>${item.technical_count}</td>
      <td><span class="status-pill ${item.deleted_at ? "done" : statusClass(item.status)}"><i></i>${item.deleted_at ? "Diarsipkan" : esc(item.status)}</span></td>
      <td class="row-actions">${canManageCases ? item.deleted_at
        ? `<button class="text-button" data-action="restore-case" data-id="${item.id}">Pulihkan</button>`
        : `<button class="text-button" data-action="edit-case" data-id="${item.id}">Ubah</button><button class="text-button danger-text" data-action="archive-case" data-id="${item.id}">Arsipkan</button>` : "—"}</td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty-state">Tidak ada perkara pada halaman ini.</td></tr>`;
  const page = state.casePagination;
  $("#cases-pagination").innerHTML = page ? paginationHtml(page, "case-page") : "";
}

function paginationHtml(pagination, key) {
  if (!pagination || pagination.total_pages <= 1) return "";
  return `<div class="pagination-controls"><span>${pagination.total} item · halaman ${pagination.page} dari ${pagination.total_pages}</span>
    <div><button class="button secondary small" data-page-key="${key}" data-page="${pagination.page - 1}" ${pagination.page <= 1 ? "disabled" : ""}>Sebelumnya</button>
    <button class="button secondary small" data-page-key="${key}" data-page="${pagination.page + 1}" ${pagination.page >= pagination.total_pages ? "disabled" : ""}>Berikutnya</button></div></div>`;
}

function pagedItems(items, key) {
  const totalPages = Math.max(1, Math.ceil(items.length / 5));
  const page = Math.min(state.detailPages[key] || 1, totalPages);
  state.detailPages[key] = page;
  return {
    items: items.slice((page - 1) * 5, page * 5),
    pagination: { page, per_page: 5, total: items.length, total_pages: totalPages }
  };
}

async function loadTeams() {
  const { teams } = await api(`/api/teams${state.teamShowArchived ? "?include_archived=1" : ""}`);
  state.teams = teams;
  const activeTeams = teams.filter(team => !team.deleted_at);
  $("#team-select").innerHTML = `<option value="">Semua Tim</option>${activeTeams.map(team => `<option value="${team.id}">${esc(team.name)}</option>`).join("")}`;
  $("#case-team").innerHTML = activeTeams.map(team => `<option value="${team.id}">${esc(team.name)}</option>`).join("");
  const peopleByTeam = await Promise.all(teams.map(async team => {
    const page = state.teamPages[team.id] || 1;
    return [team.id, await api(`/api/teams/${team.id}/users?page=${page}${state.teamShowArchived ? "&include_archived=1" : ""}`)];
  }));
  const people = Object.fromEntries(peopleByTeam);
  state.peopleByTeam = Object.fromEntries(peopleByTeam.map(([teamId, data]) => [teamId, data.users]));
  $("#team-cards").innerHTML = teams.map(team => {
    const data = people[team.id];
    const isAdmin = state.user.role === "admin";
    const canManagePeople = isAdmin || ["leader", "analyst"].includes(state.user.role);
    return `<article class="team-card panel"><div class="team-card-head"><div class="team-emblem ${team.id === 1 ? "emblem-blue" : "emblem-violet"}">${esc(team.name.slice(-1))}</div>
        <div class="row-actions">${isAdmin ? team.deleted_at
          ? `<button class="text-button" data-action="restore-team" data-id="${team.id}">Pulihkan tim</button>`
          : `<button class="text-button" data-action="edit-team" data-id="${team.id}">Ubah tim</button><button class="text-button danger-text" data-action="archive-team" data-id="${team.id}" ${team.case_count ? "disabled title=\"Arsipkan seluruh perkara tim terlebih dahulu\"" : ""}>Arsipkan tim</button>` : ""}</div></div>
      <h2>${esc(team.name)}</h2><p>${esc(team.description || "Unit analis teknis")}${team.deleted_at ? " · Diarsipkan" : ""}</p>
      <div class="team-card-leader"><span class="mini-avatar">${esc((team.leader || "T").slice(0, 1))}</span><div><small>Kepala tim</small><strong>${esc(team.leader || "Belum ditetapkan")}</strong></div></div>
      <div class="team-card-stats"><div><strong>${team.members}</strong><span>Personel aktif</span></div><div><strong>${team.active_cases}</strong><span>Perkara aktif</span></div></div>
      <div class="team-people-head"><strong>Personel</strong><span>${data.pagination.total} total</span>${canManagePeople && !team.deleted_at ? `<button class="button secondary small" data-action="add-user" data-team-id="${team.id}">＋ Tambah personel</button>` : ""}</div>
      <div class="team-people">${data.users.map(person => `<div class="person-row"><div><strong>${esc(person.name)}</strong><small>${esc(person.rank_number || "—")} · ${esc(person.specialty || "—")} · ${person.role === "leader" ? "Kepala tim" : person.role === "analyst" ? "Tim Analis" : "Anggota"}${person.deleted_at ? " · Diarsipkan" : ""}</small></div>
        <div class="row-actions">${canManagePeople && (isAdmin || person.role !== "leader") ? person.deleted_at
          ? `<button class="text-button" data-action="restore-user" data-id="${person.id}">Pulihkan</button>`
          : `<button class="text-button" data-action="edit-user" data-id="${person.id}">Ubah</button><button class="text-button danger-text" data-action="archive-user" data-id="${person.id}">Arsipkan</button>` : ""}</div></div>`).join("") || `<p class="empty-inline">Belum ada personel pada halaman ini.</p>`}</div>
      ${paginationHtml(data.pagination, `team-page-${team.id}`)}</article>`;
  }).join("");
}

async function openCase(caseId, includeArchived = false) {
  if (state.openCaseId !== caseId) {
    state.detailPages = { profiles: 1, field_reports: 1, technical_entries: 1 };
    state.detailArchived = includeArchived;
  }
  const data = await api(`/api/cases/${caseId}${state.detailArchived ? "?include_archived=1" : ""}`);
  state.openCaseId = caseId;
  state.caseDetail = data;
  const item = data.case;
  const canManage = ["admin", "leader", "analyst"].includes(state.user.role);
  const profiles = pagedItems(data.profiles, "profiles");
  const reports = pagedItems(data.field_reports, "field_reports");
  const analyses = pagedItems(data.technical_entries, "technical_entries");
  const assignedMemberIds = new Set(data.members.map(member => member.id));
  const availableMembers = (data.available_members || []).filter(member => !assignedMemberIds.has(member.id));
  const recordActions = (resource, record, editable = true) => record.deleted_at
    ? `<button class="text-button" data-action="restore-record" data-resource="${resource}" data-id="${record.id}">Pulihkan</button>`
    : editable ? `<button class="text-button" data-action="edit-record" data-resource="${resource}" data-id="${record.id}">Ubah</button><button class="text-button danger-text" data-action="archive-record" data-resource="${resource}" data-id="${record.id}">Arsipkan</button>` : "";
  const reportActions = item.deleted_at ? "" : `<button class="button secondary small report-download" data-export-report="pdf" title="Unduh laporan PDF">PDF</button><button class="button secondary small report-download" data-export-report="docx" title="Unduh laporan DOCX">DOCX</button>`;
  const detailHeaderActions = item.deleted_at
    ? `<button class="button secondary small" data-action="restore-case" data-id="${item.id}">Pulihkan perkara</button>`
    : `${reportActions}${canManage ? `<button class="button secondary small" data-action="edit-case" data-id="${item.id}">Ubah perkara</button><button class="button secondary small danger-text" data-action="archive-case" data-id="${item.id}">Arsipkan</button>` : ""}`;
  $("#case-detail").innerHTML = `
    <div class="dialog-heading"><div><p class="eyebrow">${esc(item.team_name)} · ${esc(item.lp_number)}${item.deleted_at ? " · DIARSIPKAN" : ""}</p><h2>${esc(item.title)}</h2></div><div class="row-actions">${detailHeaderActions}<button type="button" class="icon-button close-dialog" aria-label="Tutup">×</button></div></div>
    <div class="detail-meta"><span><small>TANGGAL LP</small><strong>${dateLabel(item.reported_at)}</strong></span><span><small>STATUS</small><strong>${esc(item.status)}</strong></span><span><small>TEMPAT KEJADIAN PERKARA</small><strong>${esc(item.location || "—")}</strong></span></div>
    <div class="detail-archive-toggle"><label><input id="detail-show-archived" type="checkbox" ${state.detailArchived ? "checked" : ""} ${item.deleted_at ? "disabled" : ""}><span>Tampilkan catatan yang diarsipkan</span></label></div>
    <div class="detail-columns">
      <section><div class="detail-section-title"><div><h3>Profil korban & terduga</h3><p>${data.profiles.length} profil terkait LP</p></div>${!item.deleted_at ? `<button class="button secondary small" id="add-profile">＋ Tambah profil</button>` : ""}</div>
        <div class="detail-list">${profiles.items.length ? profiles.items.map(profile => `<article class="detail-item"><div class="profile-avatar">${esc(profile.name.slice(0, 1).toUpperCase())}</div><div class="detail-item-content"><strong>${esc(profile.name)}${profile.deleted_at ? " · Diarsipkan" : ""}</strong><small><span class="tag">${esc(profile.profile_type)}</span>${profile.alias ? ` · Alias: ${esc(profile.alias)}` : ""}${profile.role_in_case ? ` · ${esc(profile.role_in_case)}` : ""}</small>${profile.nik ? `<small>NIK: ${esc(profile.nik)}</small>` : ""}${profile.phone ? `<small>Nomor HP: ${esc(profile.phone)}</small>` : ""}${profile.address ? `<small>Alamat: ${esc(profile.address)}</small>` : ""}${profile.notes ? `<p>${esc(profile.notes)}</p>` : ""}<div class="row-actions">${recordActions("profiles", profile, !item.deleted_at)}</div></div></article>`).join("") : `<p class="empty-inline">Belum ada profil korban atau terduga pada halaman ini.</p>`}</div>${paginationHtml(profiles.pagination, "detail-profiles")}</section>
      <section><div class="detail-section-title"><div><h3>Informasi dari lapangan</h3><p>${data.field_reports.length} catatan sumber</p></div>${!item.deleted_at ? `<button class="button secondary small" id="add-field-report">＋ Catat informasi</button>` : ""}</div>
        <div class="detail-list">${reports.items.length ? reports.items.map(report => `<article class="technical-item"><div class="technical-item-head"><span class="tag">${esc(report.source_unit)}</span><small>${dateLabel(report.created_at)}</small></div><strong>${esc(report.title)}${report.deleted_at ? " · Diarsipkan" : ""}</strong>${report.reference ? `<small>Referensi: ${esc(report.reference)}</small>` : ""}<p>${esc(report.details)}</p><div class="progress-actions"><small>Dicatat ${esc(report.author)}</small><div class="row-actions">${recordActions("field-reports", report, !item.deleted_at)}${!report.deleted_at && !item.deleted_at ? `<button class="text-button" data-start-analysis="${report.id}">Mulai analisis →</button>` : ""}</div></div></article>`).join("") : `<p class="empty-inline">Belum ada informasi pada halaman ini.</p>`}</div>${paginationHtml(reports.pagination, "detail-field_reports")}</section>
    </div>
    <section class="analysis-workflow"><div class="detail-section-title"><div><h3>Proses analisis teknis</h3><p>${data.technical_entries.length} perkembangan tercatat · tindak lanjut tersimpan berurutan</p></div>${!item.deleted_at ? `<button class="button secondary small" id="add-technical">＋ Catat analisis</button>` : ""}</div>
      <div class="analysis-timeline">${analyses.items.length ? analyses.items.map(entry => `<article class="technical-item"><div class="technical-item-head"><div class="tag-group"><span class="tag">${esc(entry.category)}</span><span class="status-pill ${progressClass(entry.progress_status)}"><i></i>${esc(entry.progress_status)}</span></div><small>${dateLabel(entry.created_at)}</small></div><strong>${esc(entry.title)}${entry.deleted_at ? " · Diarsipkan" : ""}</strong>${entry.source_report_title ? `<small>Sumber lapangan: ${esc(entry.source_report_title)}</small>` : ""}${entry.previous_title ? `<small>Melanjutkan: ${esc(entry.previous_title)}</small>` : ""}${entry.target_ref ? `<small>Referensi data: ${esc(entry.target_ref)}</small>` : ""}<p>${esc(entry.findings)}</p><div class="progress-actions"><small>Dicatat ${esc(entry.author)}</small><div class="row-actions">${recordActions("technical", entry, !item.deleted_at)}${!entry.deleted_at && !item.deleted_at ? `<button class="text-button" data-continue-analysis="${entry.id}">Lanjutkan →</button>` : ""}</div></div></article>`).join("") : `<p class="empty-inline">Belum ada analisis pada halaman ini.</p>`}</div>${paginationHtml(analyses.pagination, "detail-technical_entries")}
    </section>
    <section class="members-section"><div class="detail-section-title"><div><h3>Personel ditugaskan</h3><p>${data.members.length} personel pada perkara ini</p></div></div>
      <div class="member-chips">${data.members.map(member => `<span title="${esc(member.specialty)}">${esc(member.name)} <small>· ${esc(member.duty || "Personel")}</small></span>`).join("") || `<span>Belum ada penugasan</span>`}</div>
      ${canManage && !item.deleted_at ? availableMembers.length ? `<form id="assignment-form" class="assignment-form">
        <label>Personel<select name="user_id" required><option value="">Pilih personel tim</option>${availableMembers.map(member => `<option value="${member.id}">${esc(member.name)} · ${member.is_analyst ? "Tim Analis" : member.role === "leader" ? "Katim" : "Anggota"}</option>`).join("")}</select></label>
        <label>Tugas khusus<input name="duty" maxlength="100" required placeholder="Contoh: analisis data perangkat"></label>
        <button class="button secondary small" type="submit">＋ Tugaskan personel</button>
        <p id="assignment-error" class="error" role="alert"></p>
      </form>` : `<p class="assignment-note">Semua personel aktif tim ini sudah ditugaskan.</p>` : ""}</section>
    <p class="detail-disclaimer">Pengarsipan menyembunyikan catatan dari tampilan biasa dan mempertahankan jejak audit.</p>`;
  $("#detail-dialog").showModal();
  $("#case-detail .close-dialog").addEventListener("click", () => $("#detail-dialog").close());
  $("#detail-show-archived").addEventListener("change", event => {
    state.detailArchived = event.target.checked;
    state.detailPages = { profiles: 1, field_reports: 1, technical_entries: 1 };
    openCase(caseId).catch(error => alert(error.message));
  });
  $("#add-profile")?.addEventListener("click", () => openProfileForm());
  $("#add-field-report")?.addEventListener("click", () => openWorkflow("field-report"));
  $("#add-technical")?.addEventListener("click", () => openWorkflow("analysis"));
  $$("[data-export-report]", $("#case-detail")).forEach(button => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await downloadCaseReport(caseId, button.dataset.exportReport);
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  }));
  $("#assignment-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = $("#assignment-error");
    const submit = form.querySelector('button[type="submit"]');
    error.textContent = "";
    submit.disabled = true;
    const values = Object.fromEntries(new FormData(form));
    try {
      await api(`/api/cases/${caseId}/assignments`, { method: "PATCH", body: JSON.stringify(values) });
      await openCase(caseId);
    } catch (requestError) {
      error.textContent = requestError.message;
      submit.disabled = false;
    }
  });
  $$("[data-start-analysis]", $("#case-detail")).forEach(button => button.addEventListener("click", () => openWorkflow("analysis", { field_report_id: button.dataset.startAnalysis })));
  $$("[data-continue-analysis]", $("#case-detail")).forEach(button => button.addEventListener("click", () => openWorkflow("analysis", { parent_entry_id: button.dataset.continueAnalysis })));
}

function openProfileForm() {
  const form = $("#profile-form");
  form.reset();
  $("#profile-error").textContent = "";
  form.elements.profile_type.value = "Korban";
  $("#profile-dialog-title").textContent = "Tambah profil korban / terduga";
  $("#profile-dialog").showModal();
}

const editorFields = {
  case: [
    { name: "lp_number", label: "Nomor LP", required: true },
    { name: "title", label: "Judul perkara", required: true },
    { name: "reported_at", label: "Tanggal LP", type: "date", required: true },
    { name: "statute", label: "Pasal / dasar perkara" },
    { name: "location", label: "Tempat kejadian perkara (TKP)" },
    { name: "status", label: "Status", type: "select", options: ["Aktif", "Proses", "Selesai"], required: true }
  ],
  profiles: [
    { name: "profile_type", label: "Jenis profil", type: "select", options: ["Korban", "Terduga"], required: true },
    { name: "name", label: "Nama lengkap", required: true },
    { name: "nik", label: "NIK" },
    { name: "address", label: "Alamat", type: "textarea" },
    { name: "phone", label: "Nomor HP" },
    { name: "alias", label: "Alias" },
    { name: "role_in_case", label: "Peran dalam perkara" },
    { name: "notes", label: "Catatan", type: "textarea" }
  ],
  "field-reports": [
    { name: "source_unit", label: "Sumber informasi", required: true },
    { name: "title", label: "Ringkasan informasi", required: true },
    { name: "reference", label: "Referensi" },
    { name: "details", label: "Rincian", type: "textarea", required: true }
  ],
  technical: [
    { name: "category", label: "Kategori analisis", required: true },
    { name: "title", label: "Judul perkembangan", required: true },
    { name: "target_ref", label: "Referensi data" },
    { name: "progress_status", label: "Status perkembangan", type: "select", options: ["Analisis awal", "Tindak lanjut", "Selesai"], required: true },
    { name: "findings", label: "Hasil / catatan analisis", type: "textarea", required: true }
  ],
  team: [
    { name: "name", label: "Nama tim", required: true },
    { name: "description", label: "Keterangan" }
  ],
  user: [
    { name: "name", label: "Nama personel", required: true },
    { name: "rank_number", label: "Pangkat / NRP" },
    { name: "specialty", label: "Spesialisasi" },
    { name: "role", label: "Peran", type: "select", options: [{ value: "leader", label: "Katim" }, { value: "analyst", label: "Tim Analis" }, { value: "member", label: "Anggota" }], required: true }
  ]
};

function openEditor(resource, record, caseId = null) {
  const definitions = editorFields[resource].map(field => {
    if (resource !== "user" || field.name !== "role" || state.user.role === "admin") return field;
    return { ...field, options: field.options.filter(option => option.value !== "leader") };
  });
  if (!definitions) return;
  state.editor = { resource, id: record.id, caseId };
  $("#editor-title").textContent = `Ubah ${resource === "case" ? "perkara" : resource === "profiles" ? "profil" : resource === "field-reports" ? "informasi lapangan" : resource === "technical" ? "catatan analisis" : resource === "team" ? "tim" : "personel"}`;
  $("#editor-error").textContent = "";
  $("#editor-fields").innerHTML = definitions.map(field => {
    const value = record[field.name] ?? "";
    let control;
    if (field.type === "textarea") {
      control = `<textarea name="${field.name}" rows="4" ${field.required ? "required" : ""} maxlength="${field.name === "notes" ? 1000 : field.name === "address" ? 300 : field.name === "details" || field.name === "findings" ? 3000 : 500}">${esc(value)}</textarea>`;
    } else if (field.type === "select") {
      control = `<select name="${field.name}" ${field.required ? "required" : ""}>${field.options.map(option => {
        const optionValue = typeof option === "string" ? option : option.value;
        const optionLabel = typeof option === "string" ? option : option.label;
        return `<option value="${esc(optionValue)}" ${value === optionValue ? "selected" : ""}>${esc(optionLabel)}</option>`;
      }).join("")}</select>`;
    } else {
      const maxLength = ["notes"].includes(field.name) ? 1000 : field.name === "address" || field.name === "location" ? 300 : ["nik", "phone"].includes(field.name) ? 32 : 150;
      control = `<input name="${field.name}" type="${field.type || "text"}" value="${esc(value)}" ${field.required ? "required" : ""} maxlength="${maxLength}">`;
    }
    return `<label>${field.label}${control}</label>`;
  }).join("");
  $("#editor-dialog").showModal();
}

function openUserCreate(teamId) {
  const form = $("#user-form");
  form.reset();
  $("#user-error").textContent = "";
  const isAdmin = state.user.role === "admin";
  $("#user-team-field").hidden = !isAdmin;
  $("#user-team").innerHTML = state.teams.filter(team => !team.deleted_at)
    .map(team => `<option value="${team.id}" ${team.id === teamId ? "selected" : ""}>${esc(team.name)}</option>`).join("");
  form.elements.team_id.value = String(teamId);
  $("#user-role-select").innerHTML = `${isAdmin ? `<option value="leader">Katim</option>` : ""}<option value="analyst">Tim Analis</option><option value="member">Anggota</option>`;
  $("#user-role-select").value = "analyst";
  $("#user-dialog").showModal();
}

async function submitEditor(event) {
  event.preventDefault();
  if (!state.editor) return;
  $("#editor-error").textContent = "";
  const { resource, id, caseId } = state.editor;
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const endpoint = resource === "case" ? `/api/cases/${id}`
    : resource === "team" ? `/api/teams/${id}`
      : resource === "user" ? `/api/users/${id}`
        : `/api/cases/${caseId}/${resource}/${id}`;
  try {
    await api(endpoint, { method: "PATCH", body: JSON.stringify(values) });
    $("#editor-dialog").close();
    state.editor = null;
    if (resource === "team" || resource === "user") {
      await Promise.all([loadTeams(), loadDashboard()]);
    } else {
      await Promise.all([loadCases(), loadDashboard()]);
      if ($("#detail-dialog").open && (state.openCaseId === caseId || resource === "case" && state.openCaseId === id)) {
        await openCase(resource === "case" ? id : caseId);
      }
    }
  } catch (error) { $("#editor-error").textContent = error.message; }
}

function openWorkflow(kind, links = {}) {
  const form = $("#workflow-form");
  form.reset();
  state.workflow = kind;
  $("#workflow-error").textContent = "";
  $("#field-report-fields").hidden = kind !== "field-report";
  $("#analysis-fields").hidden = kind !== "analysis";
  $("#field-report-fields").querySelectorAll("input, textarea, select").forEach(control => { control.disabled = kind !== "field-report"; });
  $("#analysis-fields").querySelectorAll("input, textarea, select").forEach(control => { control.disabled = kind !== "analysis"; });
  $("#workflow-eyebrow").textContent = kind === "field-report" ? "SUMBER INFORMASI" : "PERKEMBANGAN ANALISIS";
  $("#workflow-title").textContent = kind === "field-report" ? "Catat informasi lapangan" : "Catat perkembangan analisis";
  if (kind === "analysis") {
    form.elements.field_report_id.value = links.field_report_id || "";
    form.elements.parent_entry_id.value = links.parent_entry_id || "";
    if (links.parent_entry_id) form.elements.progress_status.value = "Tindak lanjut";
  }
  $("#workflow-dialog").showModal();
}

$("#login-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#login-error").textContent = "";
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
    await loadApp();
  } catch (error) { $("#login-error").textContent = error.message; }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  state.user = null;
  showLogin();
});

$$(".nav-item").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
$$("[data-go]").forEach(button => button.addEventListener("click", () => setView(button.dataset.go)));
$("#team-select").addEventListener("change", loadDashboard);
$("#case-search").addEventListener("input", () => {
  state.casePage = 1;
  loadCases(1).catch(error => alert(error.message));
});
$("#case-show-archived").addEventListener("change", event => {
  state.caseShowArchived = event.target.checked;
  loadCases(1).catch(error => alert(error.message));
});
$("#team-show-archived").addEventListener("change", event => {
  state.teamShowArchived = event.target.checked;
  state.teamPages = {};
  loadTeams().catch(error => alert(error.message));
});
$("#new-case-button").addEventListener("click", () => {
  $("#case-error").textContent = "";
  $("#case-form").reset();
  $("#case-form").elements.reported_at.value = new Date().toISOString().slice(0, 10);
  if (state.user.role !== "admin") $("#case-form").elements.team_id.value = String(state.user.team_id);
  $("#case-form").elements.status.value = "Aktif";
  $("#case-form-title").textContent = "Daftarkan perkara baru";
  $("#case-form-submit").textContent = "Simpan perkara";
  $("#case-form").dataset.mode = "create";
  $("#case-dialog").showModal();
});
$("#add-personnel-button").addEventListener("click", () => {
  const teamId = state.user.role === "admin"
    ? state.teams.find(team => !team.deleted_at)?.id
    : state.user.team_id;
  if (teamId) openUserCreate(teamId);
});
$$(".close-dialog").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
$("#workflow-dialog .close-dialog").addEventListener("click", () => $("#workflow-dialog").close());
document.addEventListener("click", event => {
  const action = event.target.closest("[data-action]");
  if (action) {
    event.preventDefault();
    event.stopPropagation();
    handleRecordAction(action).catch(error => alert(error.message));
    return;
  }
  const pageButton = event.target.closest("[data-page-key]");
  if (pageButton && !pageButton.disabled) {
    const page = Number(pageButton.dataset.page);
    const key = pageButton.dataset.pageKey;
    if (key === "case-page") loadCases(page).catch(error => alert(error.message));
    else if (key.startsWith("team-page-")) {
      state.teamPages[key.slice("team-page-".length)] = page;
      loadTeams().catch(error => alert(error.message));
    } else {
      const detailKey = key.replace("detail-", "");
      state.detailPages[detailKey] = page;
      openCase(state.openCaseId).catch(error => alert(error.message));
    }
    return;
  }
  const row = event.target.closest("[data-case-id]");
  if (row) openCase(Number(row.dataset.caseId), row.dataset.caseArchived === "true").catch(error => alert(error.message));
});
$("#editor-form").addEventListener("submit", submitEditor);
$("#user-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#user-error").textContent = "";
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api("/api/users", { method: "POST", body: JSON.stringify(values) });
    $("#user-dialog").close();
    await loadTeams();
  } catch (error) { $("#user-error").textContent = error.message; }
});
$("#profile-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#profile-error").textContent = "";
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api(`/api/cases/${state.openCaseId}/profiles`, { method: "POST", body: JSON.stringify(values) });
    $("#profile-dialog").close();
    await openCase(state.openCaseId);
    await Promise.all([loadDashboard(), loadCases()]);
  } catch (error) { $("#profile-error").textContent = error.message; }
});
$("#case-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#case-error").textContent = "";
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api("/api/cases", { method: "POST", body: JSON.stringify(values) });
    $("#case-dialog").close();
    state.casePage = 1;
    await Promise.all([loadDashboard(), loadCases()]);
  } catch (error) { $("#case-error").textContent = error.message; }
});
$("#workflow-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#workflow-error").textContent = "";
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const isFieldReport = state.workflow === "field-report";
  const endpoint = isFieldReport
    ? `/api/cases/${state.openCaseId}/field-reports`
    : `/api/cases/${state.openCaseId}/technical`;
  try {
    await api(endpoint, { method: "POST", body: JSON.stringify(values) });
    $("#workflow-dialog").close();
    await openCase(state.openCaseId);
    await Promise.all([loadDashboard(), loadCases()]);
  } catch (error) { $("#workflow-error").textContent = error.message; }
});

async function handleRecordAction(button) {
  const { action, id, resource } = button.dataset;
  if (action === "add-user") {
    openUserCreate(Number(button.dataset.teamId));
    return;
  }
  if (action === "edit-case") {
    const record = state.cases.find(item => item.id === Number(id)) || state.caseDetail?.case;
    if (record) openEditor("case", record);
    return;
  }
  if (action === "edit-team") {
    const record = state.teams.find(item => item.id === Number(id));
    if (record) openEditor("team", record);
    return;
  }
  if (action === "edit-user") {
    const record = Object.values(state.peopleByTeam).flat().find(item => item.id === Number(id));
    if (record) openEditor("user", record);
    return;
  }
  if (action === "edit-record") {
    const listName = resource === "profiles" ? "profiles" : resource === "field-reports" ? "field_reports" : "technical_entries";
    const record = state.caseDetail?.[listName]?.find(item => item.id === Number(id));
    if (record) openEditor(resource, record, state.openCaseId);
    return;
  }

  const archive = action.startsWith("archive-");
  const restore = action.startsWith("restore-");
  if (!archive && !restore) return;
  const labels = {
    case: "perkara",
    record: resource === "profiles" ? "profil" : resource === "field-reports" ? "informasi lapangan" : "catatan analisis",
    team: "tim",
    user: "personel"
  };
  const kind = action.endsWith("-case") ? "case" : action.endsWith("-team") ? "team" : action.endsWith("-user") ? "user" : "record";
  const confirmation = kind === "team"
    ? "Arsipkan tim ini? Perkara harus diarsipkan terlebih dahulu; semua akun personel tim akan ikut diarsipkan."
    : `Arsipkan ${labels[kind]} ini? Data tetap tersimpan dan dapat dipulihkan.`;
  if (archive && !confirm(confirmation)) return;
  const endpoint = kind === "case" ? `/api/cases/${id}${restore ? "/restore" : ""}`
    : kind === "team" ? `/api/teams/${id}${restore ? "/restore" : ""}`
      : kind === "user" ? `/api/users/${id}${restore ? "/restore" : ""}`
        : `/api/cases/${state.openCaseId}/${resource}/${id}${restore ? "/restore" : ""}`;
  await api(endpoint, { method: restore ? "PATCH" : "DELETE" });
  const caseDetailIsOpen = $("#detail-dialog").open && state.openCaseId === Number(id);
  if (kind === "record") {
    await openCase(state.openCaseId);
  } else if (kind === "case" && caseDetailIsOpen) {
    if (archive) $("#detail-dialog").close();
    else {
      state.detailArchived = false;
      await openCase(Number(id));
    }
  }
  await Promise.all([loadDashboard(), loadCases()]);
  if (kind === "team" || kind === "user") await loadTeams();
}

$("#current-year").textContent = new Date().getFullYear();

api("/api/session").then(loadApp).catch(showLogin);
