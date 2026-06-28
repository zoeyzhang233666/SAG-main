do $$
declare
  new_template text := $new_mermaid$Mermaid 生成规则：
1. 保留下面模板中的 subgraph 超边结构、配色、classDef 和节点形状风格。
2. Mermaid 图代码内部禁止出现引用标记，例如 [1]、[2]、[3]、[网1]。
3. 不要在节点 ID、节点显示名、边标签、subgraph 名称中写引用标记、URL、脚注或来源说明。
4. 如需说明证据来源，必须在 Mermaid 代码块之外另起小节，标题固定写“产业链关系图引用说明”。引用编号使用普通 Markdown 形式 [1]、[2]，不要使用【1】。
5. 每一条节点定义、每一条关系连线、每一个 classDef 必须单独占一行，禁止把两条连线写在同一行。
6. 边标签只写关系名称，例如“进入”“生成”“副产”“主要下游”“终端行业”，不要写证据编号。
7. 节点 ID 使用简短安全名称，例如 原料A、工艺A、产品A、下游A、终端A；真实实体名称放在节点显示文本里。
8. 如果实体名称包含 /、-、+、%、括号、方括号、逗号、CAS号等特殊字符，不要直接用作节点 ID，只能放在节点显示文本中。
9. Mermaid 代码块内只输出 graph、subgraph、style、节点、连线和 classDef，不要输出解释文字。

Mermaid 样式模板：
graph LR
    %% ================= 原料超边 =================
    subgraph 原料超边 ["原料超边"]
        style 原料超边 fill:#F3EEF8,stroke:#7B5EA7,stroke-width:2px,color:#2E1C4A
        原料A["原料A"]:::rawMaterial
        原料B["原料B"]:::rawMaterial
    end

    %% ================= 生产工艺超边 =================
    subgraph 生产工艺超边 ["生产工艺超边"]
        style 生产工艺超边 fill:#FEF3EB,stroke:#D4764A,stroke-width:2px,color:#4E2010
        工艺A{"工艺A"}:::process
        工艺B{"工艺B"}:::process
    end

    %% ================= 中间体超边 =================
    subgraph 中间体超边 ["中间体超边"]
        style 中间体超边 fill:#F2ECF7,stroke:#8B6BAE,stroke-width:2px,color:#3D2355
        中间体A("中间体A"):::intermediate
    end

    %% ================= 企业超边 =================
    subgraph 企业超边 ["企业超边"]
        style 企业超边 fill:#F4F8FC,stroke:#4A7BA6,stroke-width:2px,color:#1A2F40
        生产企业A[(中国石化)]:::producer
        采购企业A[/恒力石化/]:::buyer
    end

    %% ================= 产品超边 =================
    subgraph 产品超边 ["产品超边"]
        style 产品超边 fill:#FDF0F5,stroke:#D47B9C,stroke-width:2px,color:#4A2035
        主产品["乙二醇"]:::product
    end

    %% ================= 直接下游产品超边 =================
    subgraph 直接下游产品超边 ["直接下游产品超边"]
        style 直接下游产品超边 fill:#EBF5F0,stroke:#3D8B62,stroke-width:2px,color:#143826
        下游A("聚酯纤维"):::downstream
        下游B("防冻液"):::downstream
    end

    %% ================= 终端行业超边 =================
    subgraph 终端行业超边 ["终端行业超边"]
        style 终端行业超边 fill:#FCF8F1,stroke:#C49B4C,stroke-width:2px,color:#4A3010
        终端A{{"纺织业"}}:::endUse
        终端B{{"汽车行业"}}:::endUse
        多领域应用{{"多领域应用"}}:::endUse
    end

    %% 关系连线
    原料A -->|进入| 工艺A
    工艺A -->|生成| 中间体A
    中间体A -->|进入| 工艺B
    工艺B -->|生成| 主产品

    %% 企业关系
    生产企业A -->|主要生产商| 主产品
    采购企业A -->|主要采购商| 下游A

    主产品 -->|主要下游| 下游A
    主产品 -->|次要下游| 下游B
    下游A -->|终端行业| 终端A
    下游B -->|终端行业| 多领域应用
    多领域应用 -->|包含| 终端B

    %% classDef 样式定义
    classDef rawMaterial fill:#DDD2EB,stroke:#7B5EA7,color:#2E1C4A
    classDef intermediate fill:#E0D7F0,stroke:#8B6BAE,color:#2A1F44
    classDef process fill:#FAD4BF,stroke:#D4764A,color:#4E2010
    classDef product fill:#F5D0DE,stroke:#D47B9C,color:#4A2035
    classDef downstream fill:#BFE0D0,stroke:#3D8B62,color:#143826
    classDef subDownstream fill:#A8D5BE,stroke:#2D6B4F,color:#0F261A
    classDef endUse fill:#F2E1C0,stroke:#C49B4C,color:#4A3010
    classDef producer fill:#D6E4F0,stroke:#4A7BA6,color:#1A2F40
    classDef buyer fill:#F9E4B7,stroke:#C48E3B,color:#402D10$new_mermaid$;
begin
  update ai_provider_settings
  set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{mermaidTemplate}', to_jsonb(new_template), true),
      updated_at = now()
  where id = 'global'
    and (
      metadata->>'mermaidTemplate' is null
      or metadata->>'mermaidTemplate' like '%图外引用说明%'
      or metadata->>'mermaidTemplate' like '%引用说明可以放在 Mermaid 代码块外%'
      or metadata->>'mermaidTemplate' not like '%产业链关系图引用说明%'
    );
end $$;
