alter table documents
  add column if not exists source_name text,
  add column if not exists source_type text,
  add column if not exists source_date text,
  add column if not exists source_author text,
  add column if not exists source_url text;

create index if not exists documents_source_type_idx on documents (source_type);
create index if not exists documents_source_date_idx on documents (source_date);
create index if not exists documents_source_author_idx on documents (source_author);
