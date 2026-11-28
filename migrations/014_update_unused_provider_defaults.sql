update ai_provider_settings
set llm_base_url = 'https://www.apihub.ink/v1',
    llm_model = 'deepseek-flash',
    updated_at = now()
where id = 'global'
  and rtrim(llm_base_url, '/') in ('https://api.302ai.cn/v1', 'https://api.302.ai/v1')
  and llm_model = 'qwen3.6-flash'
  and nullif(btrim(llm_api_key), '') is null;

update ai_provider_settings
set embedding_base_url = 'https://api.siliconflow.cn/v1',
    embedding_model = 'BAAI/bge-m3',
    updated_at = now()
where id = 'global'
  and rtrim(embedding_base_url, '/') in ('https://api.302ai.cn/v1', 'https://api.302.ai/v1')
  and embedding_model = 'text-embedding-3-large'
  and nullif(btrim(embedding_api_key), '') is null;
