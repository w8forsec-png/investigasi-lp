const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const testPassword = crypto.randomBytes(24).toString("base64url");
process.env.CMS_DB_PATH = ":memory:";
process.env.CMS_DEMO_PASSWORD = testPassword;
const { canAccessCase, db, server } = require("./server");

let baseUrl;

before(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
});

test("akses perkara dibatasi menurut peran dan penugasan", () => {
  const teamDescriptions = db.prepare("SELECT DISTINCT description FROM teams").all();
  assert.deepEqual(teamDescriptions.map(row => row.description), ["Unit analis teknis"]);
  assert.equal(db.prepare("SELECT specialty FROM users WHERE username = 'katim.bravo'").get().specialty, "Analis teknis");
  assert.equal(db.prepare("SELECT duty FROM case_members WHERE user_id = (SELECT id FROM users WHERE username = 'personel.bravo')").get().duty, "Analisis teknis");

  const admin = db.prepare("SELECT id, role, team_id FROM users WHERE username = 'admin'").get();
  const leaderAlfa = db.prepare("SELECT id, role, team_id FROM users WHERE username = 'katim.alfa'").get();
  const memberAlfa = db.prepare("SELECT id, role, team_id FROM users WHERE username = 'personel.alfa'").get();
  const memberBravo = db.prepare("SELECT id, role, team_id FROM users WHERE username = 'personel.bravo'").get();
  const analystAlfa = db.prepare(`
    SELECT id, CASE WHEN is_analyst = 1 THEN 'analyst' ELSE role END AS role, team_id
    FROM users WHERE username = 'personel.alfa'
  `).get();

  assert.equal(canAccessCase(admin, 1), true);
  assert.equal(canAccessCase(admin, 2), true);
  assert.equal(canAccessCase(leaderAlfa, 1), true);
  assert.equal(canAccessCase(leaderAlfa, 2), false);
  assert.equal(canAccessCase(memberAlfa, 1), true);
  assert.equal(canAccessCase(memberAlfa, 2), false);
  assert.equal(canAccessCase(memberBravo, 1), false);
  assert.equal(canAccessCase(memberBravo, 2), true);
  assert.equal(analystAlfa.role, "analyst");
  assert.equal(canAccessCase(analystAlfa, 1), true);
  assert.equal(canAccessCase(analystAlfa, 2), false);
  assert.equal(canAccessCase(admin, 9999), false);
});

test("ringkasan input dashboard hanya menampilkan anggota dari tim pengguna", async () => {
  const loginResponse = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "personel.alfa", password: testPassword })
  });
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];
  const response = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const { contributors, teams } = await response.json();
  assert.equal(teams.length, 0);
  assert.equal(contributors.some(person => person.name === "Personel Bravo"), false);
  assert.equal(contributors.find(person => person.name === "Personel Alfa").technical_entries_created, 1);
});

test("pergantian kata sandi memverifikasi kata sandi lama dan membatalkan sesi lain", async () => {
  const login = async password => {
    const response = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password })
    });
    return response;
  };
  const activeLogin = await login(testPassword);
  const activeCookie = activeLogin.headers.get("set-cookie").split(";")[0];
  const otherLogin = await login(testPassword);
  const otherCookie = otherLogin.headers.get("set-cookie").split(";")[0];
  const changePassword = (cookie, currentPassword, newPassword) => fetch(`${baseUrl}/api/change-password`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
  });

  assert.equal((await changePassword(activeCookie, "kata-sandi-salah", "KataSandiBaru123!")).status, 400);
  assert.equal((await changePassword(activeCookie, testPassword, "pendek")).status, 400);
  assert.equal((await changePassword(activeCookie, testPassword, "KataSandiBaru123!")).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: activeCookie } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: otherCookie } })).status, 401);
  assert.equal((await login(testPassword)).status, 401);
  assert.equal((await login("KataSandiBaru123!")).status, 200);

  assert.equal((await changePassword(activeCookie, "KataSandiBaru123!", testPassword)).status, 200);
});

test("API hanya menampilkan perkara yang diizinkan untuk pengguna", async () => {
  const anonymousResponse = await fetch(`${baseUrl}/api/cases`);
  assert.equal(anonymousResponse.status, 401);

  const loginResponse = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "personel.alfa", password: testPassword })
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

  const crossTeamCaseUpdate = await fetch(`${baseUrl}/api/cases/2`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      lp_number: "LP/DEMO/001",
      title: "Tidak berwenang",
      reported_at: "2026-01-12",
      status: "Aktif"
    })
  });
  assert.equal(crossTeamCaseUpdate.status, 404);

  const listResponse = await fetch(`${baseUrl}/api/cases`, { headers: { cookie } });
  const { cases } = await listResponse.json();
  assert.equal(cases.length, 1);
  assert.equal(cases[0].lp_number, "LP/DEMO/001");

  const hiddenCaseResponse = await fetch(`${baseUrl}/api/cases/2`, { headers: { cookie } });
  assert.equal(hiddenCaseResponse.status, 404);

  const fieldReportResponse = await fetch(`${baseUrl}/api/cases/1/field-reports`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      source_unit: "Tim Lapangan",
      title: "Informasi lapangan demonstrasi",
      reference: "Catatan harian",
      details: "Rangkuman fiktif untuk pengujian alur."
    })
  });
  assert.equal(fieldReportResponse.status, 201);
  const { id: fieldReportId } = await fieldReportResponse.json();

  const firstAnalysisResponse = await fetch(`${baseUrl}/api/cases/1/technical`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      field_report_id: fieldReportId,
      category: "Analisis dokumen",
      title: "Analisis awal demonstrasi",
      findings: "Temuan awal fiktif.",
      progress_status: "Analisis awal"
    })
  });
  assert.equal(firstAnalysisResponse.status, 201);
  const { id: firstEntryId } = await firstAnalysisResponse.json();

  const followupResponse = await fetch(`${baseUrl}/api/cases/1/technical`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      parent_entry_id: firstEntryId,
      category: "Analisis dokumen",
      title: "Tindak lanjut demonstrasi",
      findings: "Perkembangan lanjutan fiktif.",
      progress_status: "Tindak lanjut"
    })
  });
  assert.equal(followupResponse.status, 201);
  const { id: followupId } = await followupResponse.json();

  const detailResponse = await fetch(`${baseUrl}/api/cases/1`, { headers: { cookie } });
  const detail = await detailResponse.json();
  assert.equal(detail.field_reports.some(report => report.id === fieldReportId), true);
  const followup = detail.technical_entries.find(entry => entry.id === followupId);
  assert.equal(followup.field_report_id, fieldReportId);
  assert.equal(followup.parent_entry_id, firstEntryId);
  assert.equal(followup.progress_status, "Tindak lanjut");
  assert.equal(followup.source_report_title, "Informasi lapangan demonstrasi");
  assert.equal(followup.previous_title, "Analisis awal demonstrasi");

  const crossCaseResponse = await fetch(`${baseUrl}/api/cases/1/technical`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      parent_entry_id: 99999,
      field_report_id: fieldReportId,
      category: "Tidak valid",
      title: "Tidak valid",
      findings: "Tidak valid"
    })
  });
  assert.equal(crossCaseResponse.status, 400);
});

test("edit, arsip, pemulihan, dan paginasi tersedia bagi data berwenang", async () => {
  const loginResponse = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: testPassword })
  });
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];
  const headers = { cookie, "content-type": "application/json" };

  const createdIds = [];
  for (let index = 1; index <= 5; index += 1) {
    const response = await fetch(`${baseUrl}/api/cases`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        lp_number: `LP/TEST/PAGE-${index}`,
        title: `Perkara paginasi ${index}`,
        reported_at: "2026-03-01",
        team_id: 1
      })
    });
    assert.equal(response.status, 201);
    createdIds.push((await response.json()).id);
  }

  const firstPageResponse = await fetch(`${baseUrl}/api/cases?page=1`, { headers });
  const firstPage = await firstPageResponse.json();
  assert.equal(firstPage.cases.length, 5);
  assert.equal(firstPage.pagination.per_page, 5);
  assert.equal(firstPage.pagination.total, 7);
  assert.equal(firstPage.pagination.total_pages, 2);
  const secondPage = await (await fetch(`${baseUrl}/api/cases?page=2`, { headers })).json();
  assert.equal(secondPage.cases.length, 2);

  const caseId = createdIds[0];
  const updateCaseResponse = await fetch(`${baseUrl}/api/cases/${caseId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      lp_number: "LP/TEST/UPDATED",
      title: "Perkara diperbarui",
      reported_at: "2026-03-02",
      status: "Proses",
      statute: "Pasal contoh",
      location: "Wilayah contoh"
    })
  });
  assert.equal(updateCaseResponse.status, 200);
  assert.equal((await (await fetch(`${baseUrl}/api/cases/${caseId}`, { headers })).json()).case.title, "Perkara diperbarui");

  const archiveCaseResponse = await fetch(`${baseUrl}/api/cases/${caseId}`, { method: "DELETE", headers });
  assert.equal(archiveCaseResponse.status, 200);
  const activeCases = await (await fetch(`${baseUrl}/api/cases?q=LP%2FTEST%2FUPDATED`, { headers })).json();
  assert.equal(activeCases.pagination.total, 0);
  const archivedCases = await (await fetch(`${baseUrl}/api/cases?include_archived=1&q=LP%2FTEST%2FUPDATED`, { headers })).json();
  assert.equal(archivedCases.cases[0].deleted_at !== null, true);
  assert.equal((await fetch(`${baseUrl}/api/cases/${caseId}/restore`, { method: "PATCH", headers })).status, 200);

  const profileResponse = await fetch(`${baseUrl}/api/cases/1/profiles`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Profil uji", alias: "Alias", role_in_case: "Analis", notes: "Catatan" })
  });
  const profileId = (await profileResponse.json()).id;
  assert.equal(profileResponse.status, 201);
  assert.equal((await fetch(`${baseUrl}/api/cases/1/profiles/${profileId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Profil diperbarui" })
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/cases/1/profiles/${profileId}`, { method: "DELETE", headers })).status, 200);
  const activeProfiles = await (await fetch(`${baseUrl}/api/cases/1`, { headers })).json();
  assert.equal(activeProfiles.profiles.some(profile => profile.id === profileId), false);
  assert.equal((await fetch(`${baseUrl}/api/cases/1/profiles/${profileId}/restore`, { method: "PATCH", headers })).status, 200);

  const caseDetail = await (await fetch(`${baseUrl}/api/cases/1`, { headers })).json();
  const report = caseDetail.field_reports.find(item => item.title === "Informasi lapangan demonstrasi");
  assert.ok(report);
  assert.equal((await fetch(`${baseUrl}/api/cases/1/field-reports/${report.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ title: "Informasi lapangan diperbarui" })
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/cases/1/field-reports/${report.id}`, { method: "DELETE", headers })).status, 200);
  const activeDetail = await (await fetch(`${baseUrl}/api/cases/1`, { headers })).json();
  assert.equal(activeDetail.field_reports.some(item => item.id === report.id), false);
  const archivedDetail = await (await fetch(`${baseUrl}/api/cases/1?include_archived=1`, { headers })).json();
  assert.equal(archivedDetail.field_reports.find(item => item.id === report.id).title, "Informasi lapangan diperbarui");
  assert.equal((await fetch(`${baseUrl}/api/cases/1/field-reports/${report.id}/restore`, { method: "PATCH", headers })).status, 200);

  const analysis = caseDetail.technical_entries.find(item => item.title === "Tindak lanjut demonstrasi");
  assert.ok(analysis);
  assert.equal((await fetch(`${baseUrl}/api/cases/1/technical/${analysis.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ findings: "Hasil diperbarui." })
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/cases/1/technical/${analysis.id}`, { method: "DELETE", headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/cases/1/technical/${analysis.id}/restore`, { method: "PATCH", headers })).status, 200);

  const teamUpdate = await fetch(`${baseUrl}/api/teams/1`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Tim Alfa", description: "Unit analis teknis diperbarui" })
  });
  assert.equal(teamUpdate.status, 200);
  assert.equal((await (await fetch(`${baseUrl}/api/teams`, { headers })).json()).teams[0].description, "Unit analis teknis diperbarui");
  assert.equal((await fetch(`${baseUrl}/api/teams/1`, { method: "DELETE", headers })).status, 409);

  const leaderId = db.prepare("SELECT id FROM users WHERE username = 'katim.alfa'").get().id;
  assert.equal((await fetch(`${baseUrl}/api/users/${leaderId}`, { method: "DELETE", headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/users/${leaderId}/restore`, { method: "PATCH", headers })).status, 200);

  const memberId = db.prepare("SELECT id FROM users WHERE username = 'personel.alfa'").get().id;
  const memberLogin = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "personel.alfa", password: testPassword })
  });
  const memberCookie = memberLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${baseUrl}/api/users/${memberId}`, { method: "DELETE", headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: memberCookie } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/users/${memberId}/restore`, { method: "PATCH", headers })).status, 200);

  const bravoPersonId = db.prepare("SELECT id FROM users WHERE username = 'personel.bravo'").get().id;
  assert.equal((await fetch(`${baseUrl}/api/users/${bravoPersonId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Personel Bravo Diperbarui", rank_number: "BRIPTU / 2002", specialty: "Analis teknis", role: "member" })
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/users/${bravoPersonId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Personel Bravo", rank_number: "BRIPTU / 2002", specialty: "Analis teknis", role: "member" })
  })).status, 200);

  assert.equal((await fetch(`${baseUrl}/api/cases/2`, { method: "DELETE", headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/teams/2`, { method: "DELETE", headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/teams/2`, { headers })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/teams/2/restore`, { method: "PATCH", headers })).status, 200);
  const bravoUsers = await (await fetch(`${baseUrl}/api/teams/2/users?include_archived=1`, { headers })).json();
  for (const archivedUser of bravoUsers.users) {
    assert.equal((await fetch(`${baseUrl}/api/users/${archivedUser.id}/restore`, { method: "PATCH", headers })).status, 200);
  }
  assert.equal((await fetch(`${baseUrl}/api/cases/2/restore`, { method: "PATCH", headers })).status, 200);
});

test("admin dan Katim mengelola akun dengan isolasi per tim", async () => {
  const login = async (username, password) => {
    const response = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get("set-cookie").split(";")[0], "content-type": "application/json" };
  };
  const adminHeaders = await login("admin", testPassword);
  const caseResponse = await fetch(`${baseUrl}/api/cases`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ lp_number: "LP/TEST/ANALYST", title: "Perkara analis", reported_at: "2026-03-10", team_id: 1 })
  });
  assert.equal(caseResponse.status, 201);
  const { id: analystCaseId } = await caseResponse.json();

  const katimHeaders = await login("katim.alfa", testPassword);
  const ownTeams = await (await fetch(`${baseUrl}/api/teams`, { headers: katimHeaders })).json();
  assert.equal(ownTeams.teams.length, 1);
  assert.equal(ownTeams.teams[0].name, "Tim Alfa");
  assert.equal((await fetch(`${baseUrl}/api/teams/2/users`, { headers: katimHeaders })).status, 404);

  const createAccount = (headers, details) => fetch(`${baseUrl}/api/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Analis Tambahan",
      username: details.username,
      password: testPassword,
      rank_number: "BRIPTU / 3001",
      specialty: "Analisis teknis",
      role: details.role,
      team_id: details.teamId
    })
  });
  assert.equal((await createAccount(katimHeaders, { username: "analis.alfa.1", role: "analyst", teamId: 1 })).status, 201);
  assert.equal((await createAccount(katimHeaders, { username: "analis.alfa.2", role: "analyst", teamId: 1 })).status, 201);
  assert.equal((await createAccount(katimHeaders, { username: "anggota.alfa", role: "member", teamId: 1 })).status, 201);
  assert.equal((await createAccount(katimHeaders, { username: "katim.tidak", role: "leader", teamId: 1 })).status, 400);
  assert.equal((await createAccount(katimHeaders, { username: "analis.bravo", role: "analyst", teamId: 2 })).status, 403);

  const teamPeople = await (await fetch(`${baseUrl}/api/teams/1/users`, { headers: katimHeaders })).json();
  assert.equal(teamPeople.users.filter(person => person.role === "analyst").length, 3);
  const analystHeaders = await login("analis.alfa.1", testPassword);
  const analystCases = await (await fetch(`${baseUrl}/api/cases?q=LP%2FTEST%2FANALYST`, { headers: analystHeaders })).json();
  assert.equal(analystCases.cases.some(item => item.lp_number === "LP/TEST/ANALYST"), true);
  assert.equal((await fetch(`${baseUrl}/api/cases/2`, { headers: analystHeaders })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/teams/1/users`, { headers: analystHeaders })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/cases/${analystCaseId}`, {
    method: "PATCH",
    headers: analystHeaders,
    body: JSON.stringify({ lp_number: "LP/TEST/ANALYST", title: "Diperbarui oleh analis", reported_at: "2026-03-10", status: "Proses" })
  })).status, 200);
  assert.equal((await createAccount(analystHeaders, { username: "analis.alfa.3", role: "analyst", teamId: 1 })).status, 201);

  const memberHeaders = await login("anggota.alfa", testPassword);
  assert.equal((await fetch(`${baseUrl}/api/teams/1/users`, { headers: memberHeaders })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/users`, { method: "POST", headers: memberHeaders, body: JSON.stringify({}) })).status, 403);
  const memberId = teamPeople.users.find(person => person.username === "anggota.alfa").id;
  assert.equal((await fetch(`${baseUrl}/api/users/${memberId}`, { method: "DELETE", headers: katimHeaders })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/users/${memberId}/restore`, { method: "PATCH", headers: katimHeaders })).status, 200);

  assert.equal((await createAccount(adminHeaders, { username: "katim.bravo.baru", role: "leader", teamId: 2 })).status, 201);
  const adminUsers = await (await fetch(`${baseUrl}/api/teams/2/users`, { headers: adminHeaders })).json();
  assert.equal(adminUsers.users.some(person => person.username === "katim.bravo.baru" && person.role === "leader"), true);
});

test("pimpinan, Katim, dan Tim Analis dapat membuat perkara serta mencatat profil korban", async () => {
  const login = async (username, password) => {
    const response = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get("set-cookie").split(";")[0], "content-type": "application/json" };
  };
  const createCase = (headers, details) => fetch(`${baseUrl}/api/cases`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      lp_number: details.lp_number,
      title: `Uji ${details.lp_number}`,
      reported_at: "2026-03-11",
      team_id: details.team_id,
      location: details.location || "Alamat TKP contoh",
      victim_name: details.victim_name || "",
      victim_nik: details.victim_nik || "",
      victim_address: details.victim_address || "",
      victim_phone: details.victim_phone || ""
    })
  });

  const adminHeaders = await login("admin", testPassword);
  assert.equal((await createCase(adminHeaders, { lp_number: "LP/ROLE/ADMIN", team_id: 2 })).status, 201);

  const leaderHeaders = await login("katim.alfa", testPassword);
  const leaderCaseResponse = await createCase(leaderHeaders, {
    lp_number: "LP/ROLE/KATIM",
    team_id: 1,
    location: "Jalan Contoh Nomor 10",
    victim_name: "Korban Uji",
    victim_nik: "1234567890123456",
    victim_address: "Alamat korban contoh",
    victim_phone: "081234567890"
  });
  assert.equal(leaderCaseResponse.status, 201);
  const { id: leaderCaseId } = await leaderCaseResponse.json();
  const caseDetail = await (await fetch(`${baseUrl}/api/cases/${leaderCaseId}`, { headers: leaderHeaders })).json();
  assert.equal(caseDetail.case.team_id, 1);
  assert.equal(caseDetail.case.location, "Jalan Contoh Nomor 10");
  assert.equal(caseDetail.profiles[0].profile_type, "Korban");
  assert.equal(caseDetail.profiles[0].name, "Korban Uji");
  assert.equal(caseDetail.profiles[0].nik, "1234567890123456");
  assert.equal(caseDetail.profiles[0].address, "Alamat korban contoh");
  assert.equal(caseDetail.profiles[0].phone, "081234567890");

  const profileUpdate = await fetch(`${baseUrl}/api/cases/${leaderCaseId}/profiles/${caseDetail.profiles[0].id}`, {
    method: "PATCH",
    headers: leaderHeaders,
    body: JSON.stringify({ profile_type: "Korban", phone: "089999999999" })
  });
  assert.equal(profileUpdate.status, 200);
  const invalidProfileType = await fetch(`${baseUrl}/api/cases/${leaderCaseId}/profiles/${caseDetail.profiles[0].id}`, {
    method: "PATCH",
    headers: leaderHeaders,
    body: JSON.stringify({ profile_type: "Saksi" })
  });
  assert.equal(invalidProfileType.status, 400);

  const analystHeaders = await login("personel.alfa", testPassword);
  assert.equal((await createCase(analystHeaders, { lp_number: "LP/ROLE/ANALIS", team_id: 1 })).status, 201);
  assert.equal((await createCase(analystHeaders, { lp_number: "LP/ROLE/ANALIS-CROSS", team_id: 2 })).status, 403);

  const memberCreate = await fetch(`${baseUrl}/api/users`, {
    method: "POST",
    headers: leaderHeaders,
    body: JSON.stringify({ name: "Anggota Uji", username: "anggota.perkara.uji", password: testPassword, role: "member", team_id: 1 })
  });
  assert.equal(memberCreate.status, 201);
  const memberHeaders = await login("anggota.perkara.uji", testPassword);
  assert.equal((await createCase(memberHeaders, { lp_number: "LP/ROLE/ANGGOTA", team_id: 1 })).status, 403);
});
