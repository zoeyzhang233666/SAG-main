update ai_provider_settings
set
  llm_timeout_ms = 300000,
  updated_at = now()
where id = 'global'
  and llm_timeout_ms = 60000;
