-- Normalize the Mermaid diagram citation section heading.
-- This migration is safe to run even if the heading has already been updated.
update ai_settings
set metadata = jsonb_set(
  coalesce(metadata, '{}'::jsonb),
  '{mermaidTemplate}',
  to_jsonb(
    replace(
      replace(metadata->>'mermaidTemplate', '图谱引用说明（点击编号查看原文）', '产业链关系图引用说明'),
      '图谱引用说明',
      '产业链关系图引用说明'
    )
  ),
  true
),
updated_at = now()
where source_id is null
  and metadata ? 'mermaidTemplate'
  and (
    metadata->>'mermaidTemplate' like '%图谱引用说明%'
    or metadata->>'mermaidTemplate' like '%图谱引用说明（点击编号查看原文）%'
  );
