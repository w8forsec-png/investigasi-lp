export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Relationship<ForeignKey extends string, Column extends string, Relation extends string> = {
  foreignKeyName: ForeignKey;
  columns: [Column];
  isOneToOne: boolean;
  referencedRelation: Relation;
  referencedColumns: ["id"];
};

type Table<Row extends object, Relations extends Relationship<string, string, string>[] = []> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: Relations;
};

type Timestamped = { created_at: string };

export type Database = {
  public: {
    Tables: {
      teams: Table<{ id: number; name: string; description: string; deleted_at: string | null } & Timestamped>;
      users: Table<{
        id: number; auth_user_id: string | null; name: string; rank_number: string; specialty: string;
        role: "admin" | "leader" | "member"; is_analyst: boolean; team_id: number | null;
        username: string; active: boolean; deleted_at: string | null;
      } & Timestamped>;
      cases: Table<{
        id: number; lp_number: string; title: string; reported_at: string; statute: string; location: string;
        status: "Aktif" | "Proses" | "Selesai"; team_id: number; created_by: number; deleted_at: string | null;
      } & Timestamped, [Relationship<"cases_team_id_fkey", "team_id", "teams">]>;
      case_members: Table<{ case_id: number; user_id: number; duty: string }, [
        Relationship<"case_members_case_id_fkey", "case_id", "cases">,
        Relationship<"case_members_user_id_fkey", "user_id", "users">
      ]>;
      profiles: Table<{
        id: number; case_id: number; profile_type: "Korban" | "Terduga"; name: string; alias: string;
        nik: string; address: string; phone: string; role_in_case: string; notes: string;
        created_by: number; deleted_at: string | null;
      } & Timestamped, [
        Relationship<"profiles_case_id_fkey", "case_id", "cases">,
        Relationship<"profiles_created_by_fkey", "created_by", "users">
      ]>;
      field_reports: Table<{
        id: number; case_id: number; source_unit: string; title: string; reference: string; details: string;
        created_by: number; deleted_at: string | null;
      } & Timestamped, [
        Relationship<"field_reports_case_id_fkey", "case_id", "cases">,
        Relationship<"field_reports_created_by_fkey", "created_by", "users">
      ]>;
      technical_entries: Table<{
        id: number; case_id: number; category: string; title: string; target_ref: string; findings: string;
        field_report_id: number | null; parent_entry_id: number | null;
        progress_status: "Analisis awal" | "Tindak lanjut" | "Selesai";
        created_by: number; deleted_at: string | null;
      } & Timestamped, [
        Relationship<"technical_entries_case_id_fkey", "case_id", "cases">,
        Relationship<"technical_entries_created_by_fkey", "created_by", "users">,
        Relationship<"technical_entries_field_report_id_fkey", "field_report_id", "field_reports">,
        Relationship<"technical_entries_parent_entry_id_fkey", "parent_entry_id", "technical_entries">
      ]>;
      audit_log: Table<{
        id: number; actor_id: number; action: string; case_id: number | null; detail: string;
      } & Timestamped>;
    };
    Views: Record<string, never>;
    Functions: {
      create_case_with_victim: {
        Args: {
          p_lp_number: string; p_title: string; p_reported_at: string; p_statute: string;
          p_location: string; p_team_id: number; p_actor_id: number; p_victim_name: string;
          p_victim_nik: string; p_victim_address: string; p_victim_phone: string;
        };
        Returns: number;
      };
      archive_team: { Args: { target_team_id: number; actor_id: number }; Returns: undefined };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
