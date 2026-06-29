# import-prep：网页版 AI → SAG 导入预处理

把"分章节让网页版 AI 抽取出来的多个 JSON 片段"合并成 SAG 可一次性导入的**单个文档**，
并按导入端真实规则校验、连续重排切片编号。

## 为什么需要它

- SAG **每次导入都会新建一个文档**（`manualIngestionService.ingest` 每次都新建 documentId）。
  所以同一来源文档的所有章节，必须先合并成 1 个文件、1 次导入，才会落在同一个文档下。
  标题相同**不会**让多次导入自动合并。
- CSV 导入要求每行列数严格等于表头，长中文字段里的逗号/引号/换行最容易让网页版 AI 写错列数。
  **用 JSON 代替 CSV**：没有分隔符可数错，校验也更清晰。
- 切片编号必须在文档内唯一。脚本统一重排成 `1..N`，章节之间天然连续，你不用手动维护。

## 用法

```bash
# 1) 把每节 AI 输出的 JSON 存成 01-xxx.json、02-xxx.json…… 放进同一目录
# 2) 在目录里放 meta.json（文档标题 + 来源信息，整篇只填一次）
# 3) 合并 + 校验 + 重排
node tools/import-prep/merge-and-validate.mjs <章节JSON目录>
node tools/import-prep/merge-and-validate.mjs "tools/import-prep/示例-化工产业链"
```

通过后会在目录里生成 `<标题>-simple-import.json`，到 SAG 网页
"粘贴或上传网页版 AI 的数据"上传它即可。

### 选项

| 选项 | 作用 |
| --- | --- |
| `--title "文档标题"` | 覆盖标题（否则取 meta.json 的 title，再否则取目录名） |
| `--out <文件>` | 自定义输出路径 |
| `--meta <meta.json>` | 指定来源信息文件（默认读目录下 meta.json） |
| `--force` | 即使有硬错误也写出（不推荐） |

### meta.json 示例

```json
{
  "title": "ABS产业链梳理",
  "source": { "name": "某券商化工深度", "type": "report", "date": "2025-03", "author": "XX证券", "url": "" }
}
```

## 脚本会自动处理的网页版 AI 常见瑕疵

- 输出被 ```` ```json ```` 代码块包住 → 自动剥离
- JSON 前后有"好的，以下是结果："之类解释文字 → 自动从第一个 `{`/`[` 起做括号配对截取
- 对象/数组结尾多了逗号 → 自动去除后重试
- 文件头 BOM → 自动去除
- keywords 写成 `"a；b；c"` 字符串而非数组 → 自动按 `；、,，;` 切成数组
- 实体缺 type/description → 自动补默认值（type=subject）

## 校验规则（与导入端一致）

硬错误（不修就不写出文件）：
- 某切片缺 `content`（原文切片）
- 某切片缺 `event.title`（事件标题）
- 某事件没有任何含 `name` 的实体

软提醒（不阻断，仅提示质量）：
- `content` 与 `event.content` 完全相同
- 原文较长却只抽到 1 个实体

## 每节 AI 输出应长这样

```json
{ "chunks": [
  { "key": "1", "heading": "…", "content": "…原文证据…",
    "event": { "title": "…", "summary": "…", "content": "…去冗余事实…",
      "category": "…", "keywords": ["…"],
      "entities": [ { "type": "产品", "name": "…", "description": "…", "relation": "…" } ] } }
] }
```

配套提示词见 `docs/CHEMICAL-JSON-SECTION-PROMPT.md`。

脚本和要合并的文件夹路径**不用放在一起**。

关系是这样的：脚本待在它自己的位置不动，你跑的时候**用一个路径"告诉"它去哪个文件夹找资料**。那个路径可以指向电脑上任何地方的文件夹。

```
node tools/import-prep/merge-and-validate.mjs   "要合并的文件夹路径"
        └─ 脚本在哪（固定不动）                      └─ 资料在哪（你指给它）
```

## 两种情况

**① 资料文件夹放在项目里**（比如就放在 `tools/import-prep/` 下面），路径可以写短的相对路径：

```powershell
node tools/import-prep/merge-and-validate.mjs "tools/import-prep/我的氯碱资料"
```

**② 资料文件夹放在别处**（比如桌面、坚果云的其它地方都行），就写完整路径：

```powershell
node tools/import-prep/merge-and-validate.mjs "C:\Users\EDY\Desktop\我的氯碱资料"
```

两种都可以，脚本照样能跑，生成的成品 `-simple-import.json` 会出现在**你指的那个资料文件夹里**。

## 唯一要注意的

命令最前面那段 `node tools/import-prep/merge-and-validate.mjs` 是相对项目根目录写的，所以**终端要在项目文件夹里**（也就是 `SAG-main` 这个目录）。如果你用我前面说的"选择 A"——直接让我帮你跑——这些你都不用管，把你资料文件夹的路径发我就行。

简单记：**脚本不动，路径指过去。**
