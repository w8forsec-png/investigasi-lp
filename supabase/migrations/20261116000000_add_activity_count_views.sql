create view public.case_activity_counts as
select activity.case_id,
  count(*) filter (where activity.kind = 'profile')::bigint as profile_count,
  count(*) filter (where activity.kind = 'technical')::bigint as technical_count
from (
  select case_id, 'profile'::text as kind
  from public.profiles
  where deleted_at is null
  union all
  select case_id, 'technical'::text as kind
  from public.technical_entries
  where deleted_at is null
) activity
group by activity.case_id;

create view public.team_contributor_activity as
select activity.team_id, activity.user_id,
  count(*) filter (where activity.kind = 'case')::bigint as cases_created,
  count(*) filter (where activity.kind = 'profile')::bigint as profiles_created,
  count(*) filter (where activity.kind = 'field_report')::bigint as field_reports_created,
  count(*) filter (where activity.kind = 'technical')::bigint as technical_entries_created
from (
  select team_id, created_by as user_id, 'case'::text as kind
  from public.cases
  where deleted_at is null
  union all
  select c.team_id, p.created_by, 'profile'::text
  from public.profiles p
  join public.cases c on c.id = p.case_id
  where p.deleted_at is null and c.deleted_at is null
  union all
  select c.team_id, r.created_by, 'field_report'::text
  from public.field_reports r
  join public.cases c on c.id = r.case_id
  where r.deleted_at is null and c.deleted_at is null
  union all
  select c.team_id, e.created_by, 'technical'::text
  from public.technical_entries e
  join public.cases c on c.id = e.case_id
  where e.deleted_at is null and c.deleted_at is null
) activity
group by activity.team_id, activity.user_id;

revoke all on public.case_activity_counts, public.team_contributor_activity
  from public, anon, authenticated;
grant select on public.case_activity_counts, public.team_contributor_activity
  to service_role;

notify pgrst, 'reload schema';
