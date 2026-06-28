do $$
declare
  old_template text := $old_mermaid$graph LR
    subgraph 原料超边 ["原料超边"]
        style 原料超边 fill:#F3EEF8,stroke:#7B5EA7,stroke-width:2px,color:#2E1C4A
        原料A["原料A"]:::rawMaterial
    end

    subgraph 生产工艺超边 ["生产工艺超边"]
        style 生产工艺超边 fill:#FEF3EB,stroke:#D4764A,stroke-width:2px,color:#4E2010
        工艺A{"工艺A"}:::process
    end

    subgraph 产品超边 ["产品超边"]
        style 产品超边 fill:#FDF0F5,stroke:#D47B9C,stroke-width:2px,color:#4A2035
        主产品["主产品"]:::product
    end

    subgraph 直接下游产品超边 ["直接下游产品超边"]
        style 直接下游产品超边 fill:#EBF5F0,stroke:#3D8B62,stroke-width:2px,color:#143826
        下游A("下游产品"):::downstream
    end

    subgraph 终端行业超边 ["终端行业超边"]
        style 终端行业超边 fill:#FCF8F1,stroke:#C49B4C,stroke-width:2px,color:#4A3010
        终端A{{"终端行业"}}:::endUse
    end

    原料A -->|进入| 工艺A
    工艺A -->|生成| 主产品
    主产品 -->|主要下游| 下游A
    下游A -->|终端行业| 终端A

    classDef rawMaterial fill:#DDD2EB,stroke:#7B5EA7,color:#2E1C4A
    classDef process fill:#FAD4BF,stroke:#D4764A,color:#4E2010
    classDef product fill:#F5D0DE,stroke:#D47B9C,color:#4A2035
    classDef downstream fill:#BFE0D0,stroke:#3D8B62,color:#143826
    classDef endUse fill:#F2E1C0,stroke:#C49B4C,color:#4A3010$old_mermaid$;
  new_template text := $new_mermaid$graph LR
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
      or btrim(metadata->>'mermaidTemplate') = btrim(old_template)
    );
end $$;
