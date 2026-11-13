alter table public.technical_entries
  add column if not exists parent_entry_id bigint;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'technical_entries_parent_entry_id_fkey'
      and conrelid = 'public.technical_entries'::regclass
  ) then
    alter table public.technical_entries
      add constraint technical_entries_parent_entry_id_fkey
      foreign key (parent_entry_id)
      references public.technical_entries(id)
      not valid;
  end if;
end
$$;

notify pgrst, 'reload schema';
