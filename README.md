# Dashboard Penanganan Perkara

Aplikasi Next.js untuk deployment di Vercel dengan Supabase Auth dan PostgreSQL. Antarmuka responsif yang sudah ada dipertahankan, sementara API menggunakan sesi Supabase dan tabel-tabel Supabase untuk perkara, tim, personel, profil, catatan lapangan, analisis teknis, dan audit.

## Menyiapkan Supabase

1. Buat proyek Supabase.
2. Jalankan SQL pada `supabase/migrations/20260601000000_initial_schema.sql` melalui Supabase SQL Editor atau Supabase CLI. Migrasi ini membuat tabel, fungsi pembatasan akses, kebijakan RLS baca, indeks, serta Tim Alfa dan Bravo.
3. Jika proyek sudah memakai skema awal, jalankan migrasi `supabase/migrations/20261113000000_ensure_analysis_parent_fk.sql` agar relasi tindak lanjut analisis tersedia dan cache skema PostgREST dimuat ulang.
4. Isi variabel lingkungan lokal berdasarkan `.env.example`:

   ```text
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_ANON_KEY=
   SUPABASE_SERVICE_ROLE_KEY=
   ```

   `SUPABASE_SERVICE_ROLE_KEY` hanya digunakan server dan tidak boleh menggunakan awalan `NEXT_PUBLIC_` atau dimasukkan ke kode/browser.
5. Siapkan akun admin awal. Atur `CMS_ADMIN_USERNAME`, `CMS_ADMIN_PASSWORD` (minimal 12 karakter), dan `CMS_ADMIN_NAME`, lalu jalankan `npm run bootstrap:admin`. Skrip tidak mempunyai password bawaan.

Supabase Auth memakai alamat internal berbentuk `<username>@cms.invalid`; pengguna tetap masuk melalui nama pengguna pada tampilan aplikasi. Akun personel dibuat dari menu Tim & Personel. Password awal perlu diberikan lewat kanal terpisah.

## Menjalankan dan deploy

Gunakan Node.js 22 atau yang lebih baru:

```powershell
npm install
npm run dev
```

Buka `http://localhost:3000`. Untuk pemeriksaan deployment:

```powershell
npm run build
npm start
```

Di Vercel, impor repository, tambahkan tiga variabel Supabase di atas pada Project Settings → Environment Variables, lalu deploy. Tidak perlu menjalankan server SQLite terpisah.

## Laporan perkara

Buka detail perkara aktif, lalu pilih **PDF** atau **DOCX** untuk mengunduh laporan yang mencakup ringkasan perkara, profil, informasi lapangan, analisis teknis, dan personel yang ditugaskan. Pengunduhan mengikuti hak akses perkara pengguna yang sedang masuk.

## Data lama

Database SQLite pada `data/cases.db` tidak otomatis dimigrasikan ke Supabase, dan akun/password lokal tidak bisa dipindah langsung ke Supabase Auth. Migrasi data lama harus direncanakan serta divalidasi terpisah sebelum menyalin data sensitif. Server SQLite lama hanya dipertahankan sementara sebagai referensi dan untuk tes kompatibilitas lokal; deployment Next.js tidak menggunakannya.

## Keamanan dan batasan

- Akses perkara diperiksa di API berdasarkan peran, tim, dan penugasan. SQL migration juga mengaktifkan RLS dan kebijakan baca untuk pembatasan data.
- Route server memakai service role untuk operasi yang memerlukan pengelolaan akun; jangan memanggil key itu dari browser. Sebelum penggunaan operasional, lakukan security review independen dan uji kebijakan RLS dengan setiap peran.
- Gunakan HTTPS, MFA, perlindungan login, backup/retensi, dan pengelolaan secret yang sesuai. Jangan gunakan data pribadi nyata sebelum tinjauan keamanan, hukum, dan operasional.
- Integrasi operator/OSINT, upload lampiran, GIS, deteksi irisan lintas tim, dan link analysis belum tersedia.

## Pengujian

```powershell
npm test
npm run build
```
