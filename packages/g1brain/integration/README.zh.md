---
description: "桌面工作台使用的 G1brain 宿主目录服务及限定会话范围的本体、文档工具。"
kind: "package-reference"
---

# G1brain 集成

[English](README.md) | 中文

## 概述

桌面工作台显示本体、领域和文档库目录的显示名，并保留 API 标识。普通会话有 16 个只读发现与检索工具。准备会话先绑定材料目录和本体目标，再提供 46 个限定范围工具；配置表格服务后为 55 个。规整 Excel 工作表进入按领域绑定的数据集合，说明性工作表进入所选向量文档库。仅表格会话无需选择向量文档库。服务凭据保留在宿主侧。

## 目录

- [使用](#use-this-package)
- [理解此包](#understand-the-package)
- [延伸阅读](#further-reading)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用

本地开发桌面版或带有明确标记的未签名测试安装包会提供 `G1BRAIN_BASE_URL`（`http://192.168.100.113:19091`）、`G1BRAIN_LOCAL_USER_ID`（`developer`）、`G1BRAIN_LOCAL_CLIENT_ID`（`g1brain-web`）、`G1BRAIN_ALLOW_LOCAL_DEV=1` 和 `G1BRAIN_ALLOW_DEV_WRITES=1`；环境变量可覆盖这些默认值。宿主会沿用旧客户端的 `X-User-Id`、`X-Client-Id` 请求头；此测试身份与登录时输入的用户名无关。开发和未签名测试配置均启用写入，并不代表登录用户的真实授权。其他部署须自行配置服务地址和认证参数。OAuth 模式需设置 `G1BRAIN_ACCESS_TOKEN` 与 `G1BRAIN_CLIENT_SECRET`（可选设置 `G1BRAIN_CLIENT_ID`）；宿主会发送 Basic 认证与 `Blade-Auth`。`G1BRAIN_TENANT_ID` 默认是 `000000`。没有对应认证参数时，插件仍启用但报告 `configured: false`，目录调用会明确报错。桌面登录暂未向宿主服务传递登录身份或 OAuth 令牌。

工作台为新的顶层会话调用 `bindSession`。宿主校验所选目录就是该会话的工作区，并将完整目标保存于仅所有者可读写的私有绑定文件。限定范围工具只安装在对应智能体中；恢复智能体时重新读取绑定。工具执行时再次检查会话、目标、原始输入结构和目录范围。新增、修改、上传、文档处理任务提交/取消及追加式整包导入无需额外确认。删除和 `replace=true` 的整包导入须提供 `confirm=true`，并逐次取得 Harness 审批；此参数只表示删除意图，不代表用户已经批准。删除授权不共享、不复用。适用的非删除工具保留可选的旧版确认参数。上传仍须明确列出文件并逐一预检路径。旧版的 5 个智能体管理工具有意不开放。

文档处理沿用当前 G1brain 网页的 MD 接口：上传后先提交 `MD` 切片任务并确认成功，再提交 `CHUNK` 的关键词、向量化和索引操作。提交工具可选择绑定文档库内的全部现有文件，也可指定经过该库校验的文档 ID。7 个任务工具覆盖提交、当前/历史列表、详情、逐文件状态、限时等待与取消。列表和详情只返回摘要，避免大型任务占满模型上下文。

新绑定会将用户输入的本体集合和领域名称保留为显示名，将不安全的名称转换为稳定且按会话区分的 ASCII 标识。已经有效的小写标识保持不变。集合显示名保存到 `attributes.displayName`；领域显示名通过配置 `PATCH` 保存并回读验证。绑定回执返回持久化后的标识，用于会话说明；创建工具同时返回标识与显示名。已有资源引用和旧绑定不会在读取时改名。旧绑定中的不安全创建标识会在发送请求前报错，此时应重新准备会话。系统 schema/shared 领域不能绑定为优化目标，也不能作为限定范围写入工具的操作目标。领域创建后的显示名保存失败，可能留下未设置预期显示名的新领域；工具会报告失败，不会宣称全部成功。

文件读取会提取 DOCX 段落与表格，以及按工作表分组的 XLSX/XLS 单元格。文本输入支持严格 UTF-8 或带 BOM 的 UTF-16；其他编码会报错，不会插入替换字符。文档上传将提取出的 UTF-8 Markdown 而非 Office 原始二进制发送到 MD API。非 Markdown 文档保留原后缀并追加 `.md`，因此 `report.docx` 与 `report.xlsx` 不会混淆。首次请求前须确保所有文件解析成功且上传名称不重复。原文件保持不变。文件大小上限约束 Office 解压总量；读取另有输出上限，不截断正文。开始上传后若 HTTP 请求失败，可能留下部分已上传文件。文档任务的 `collectionName` 是绑定文档库的 API 名称，不能使用本体集合、领域或显示名称。

<a id="excel-data-routing"></a>
### Excel 数据分流

在集成中设置 `tableBaseUrl`，或在桌面配置中设置 `G1BRAIN_TABLE_BASE_URL`，即可启用表格服务。本地开发和带有明确未签名测试标记的桌面配置默认使用 `http://192.168.100.113:8090`；显式环境变量优先。`tableTimeoutMs` 默认 120000，`tableMaxUploadBytes` 默认 26214400。这些设置不会向表格服务发送 G1brain 凭据。当前服务没有应用级认证，只应部署在可信开发网络，不应直接公开。

预检按工作表分类 XLSX/XLS。完整、不重复的文本表头和规则记录生成仅含已保存值的 XLSX；正文、含义不明的表头、合并数据、合计和未计算公式仍按文档处理。混合文件生成数据工作簿及 `.notes.md` 文档。不修改源文件，不执行公式或外部引用。文本编号和带前导零的数字编号仍保存为文本；不安全的大整数明确报错，不导入已舍入值。上限为每批 20 个文件、每本 50 个工作表、每表 200 列及 100000 条记录、200 万个检查单元格，以及整批 50 MiB 派生上传内容。未选择向量文档库而存在文档内容时，整批会在任何写入前被阻止。不配置表格服务时，仍保留原有全部转 Markdown 的流程。

宿主将每组 G1brain 服务/租户/集合/领域及表格服务地址绑定到一个表格集合。集合优先使用领域显示名，否则使用 API 名称。同名的其他来源集合不会被复用，而是追加稳定后缀。私有、带版本的映射和上传记录保存在 `$DSH_HOME/g1brain/tables`。内容相同且已接受的上传复用回执；尚未解决的上传意图阻止盲目重试。传输后断网或崩溃时，需由操作人员核对服务端任务后再决定重试。修改服务配置会建立不同映射，不会迁移之前的表格数据。

上传返回已接受的任务 ID，而非已完成的数据表。需查询领域导入状态：只有 `completed` 表示完成；`partial`、`needs_input`、`failed` 以及不在服务最近 100 个任务中的结果均属于未完成或未知。表头修复只可为本领域拥有的阻塞任务补齐明确缺失的列名，不能舍弃列。表格工具通过绑定集合的 MCP 端点读取结构并执行只读 SQL，服务端仍须执行范围校验。精确小数和大整数字符串保持原样返回。表格导入不提交 MD/CHUNK 任务，也不自动创建本体个体。集合删除不作为自动工具开放；服务的删除集合端点会保留数据表及原始文件。

绑定存储在 POSIX 上检查私有目录权限；Windows 依赖当前用户配置目录的 ACL，不以合成的 POSIX 权限位判断。目录匹配采用对应平台的路径比较规则，包括 Windows 盘符大小写。恢复智能体时若无法读取绑定或材料目录，会使初始化失败，而非悄悄退回只读工具。

未绑定的普通会话可列出本体集合、领域、分类树节点、属性、关系定义与类型、实体和关系边；也可列出文档，执行混合检索、QA 检索、片段定位与片段列表查询。只有这些明确列出的只读工具全局开放；输入会校验，返回文本最多 32 KiB，超出时附截断提示。它们使用宿主配置的 G1brain 身份，而非桌面登录时经服务端验证的用户身份。

<a id="understand-the-package"></a>
## 理解此包

宿主插件负责服务凭据、资源目录、持久会话绑定和逐次授权。客户端页面调用其目录及绑定方法；普通会话只获得全局只读工具。

宿主产物内嵌固定版本的 SheetJS 解析器及其许可和声明文本。CDN 压缩包只作为构建依赖，不是安装后的插件依赖，因此桌面生产组装仍保留 pnpm 对异源传递依赖的限制。构建产物的 Loader 流程会在禁止解析外部 `xlsx` 包的环境中读取和上传 Excel 材料。

<a id="further-reading"></a>
## 延伸阅读

- [G1brain 工作台界面](../../client/ui-g1brain/README.zh.md)
- [桌面版设置](../../../apps/desktop/README.zh.md)

<a id="model-experience"></a>
## 模型体验

### 工作流指引

#### 模型看到的内容

固定的 `g1brain:workflow` 系统段加入以下文本。[录制的系统提示](../../../snapshots/session/g1brain-session-guidance/system-prompt.expected.md) 验证其插入位置。

##### 工作流指令

```markdown
## G1brain workflow

Reply in the language of the current user request, including progress updates, clarification questions, and the final result. Use Simplified Chinese for Chinese requests unless the user explicitly asks for another language.

Use the available G1brain tools for ontology and document operations. Ordinary Sessions provide discovery and search; creation and updates require a G1brain build or improvement Session prepared with the selected ontology, domain, document library, and source folder.

If write tools are absent, explain that this Session is read-only and direct the user to prepare a G1brain build or improvement Session. Do not interpret missing write tools as missing API credentials or ask the user to install another plugin.

Before writing in a prepared Session, call g1brain_context and use its bound collection and domain API names for creation and all later references. Display names are labels only; never translate or regenerate bound identifiers. System domains such as _schema and _shared are not business write targets.

Use g1brain_read_selected_file to extract DOCX or Excel text and tables, not a raw text read of Office bytes. Document uploads extract UTF-8 Markdown before ingestion. Unsupported or encrypted files must be converted first; never upload garbled text as a successful extraction. Document uploads and processing tasks use the document library API name from the Session context, not the ontology collection name or a display name.

When g1brain_inspect_materials is available, inspect selected sources before importing. The upload tool routes regular Excel worksheets to the domain-bound table collection and explanatory sheets to the selected vector document library. Mixed workbooks are split by worksheet without changing the original. Only document uploads need MD/CHUNK tasks; table uploads return job IDs and require g1brain_get_table_imports to report completed. partial, failed, needs_input, and missing jobs are not success. Do not repeat an uncertain write. For table answers use g1brain_list_data_tables, g1brain_describe_data_table, and read-only SQL through g1brain_query_data_tables, not vector search arithmetic. Do not discard columns or invent missing header meanings. Same collection names alone do not authorize reusing another ontology domain’s table collection.

In a prepared Session, inspect the sources and cite evidence. Execute requested creation, updates, uploads, and document processing within the bound resources without asking for extra confirmation. A request only for information or a plan is not a request to write data. Ask clarification questions only when the intended scope or business requirement is ambiguous.

Deletion and replacement imports that may remove existing content require approval for each call. Set confirm=true for those calls and let Harness request approval; do not ask for a separate chat confirmation. Missing or rejected approval must prevent the deletion.
```

#### Token 影响

配置完成的集成会在每次智能体请求中加入这段固定内容，不随资源目录大小变化。

#### KV Cache 影响

普通会话与准备会话使用相同段落；更新或启用集成时，其文本会改变系统前缀。

### 目录与绑定会话工具

#### 模型看到的内容

配置 API 凭据后，每个智能体可见 16 个 G1brain 资源发现与文档检索只读工具，包括 `g1brain_list_ontology_domains` 和 `g1brain_hybrid_search`。两个全局顶层目录工具只返回名称；其他全局查询返回有长度限制的文本。绑定会话可见 46 个限定范围的本体/文档工具，配置表格服务后另有 9 个预检、表格查询、导入状态及表头修复工具，其中目录工具可返回完整后端记录。未绑定会话看不到这些限定范围工具；关闭写入时，写入工具不会出现。结果以普通文本显示在会话中。

#### Token 影响

每个可见工具都会在请求中增加固定定义。普通会话现在包含 16 个 G1brain 只读工具定义；绑定会话的前缀明显更长。调用返回的数据会再增加结果文本，全局查询结果设有上限。

#### KV Cache 影响

同一普通或绑定会话内的定义保持稳定；绑定会话或调整写入策略会改变其提示前缀。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 开发模式登录不校验身份，也不授予后端写入权限。`developer` 是共享测试身份，仅应在开发服务使用。非删除写入会在所选目标范围内自动执行，请仔细选择目标。
- 非删除操作自动执行，不代表模型生成的记录符合预期业务含义。应检查结果，发现偏离时停止执行。其他 Harness 工具（包括命令与文件操作）仍遵循各自的审批策略。
- 提交文档任务只会安排服务端处理，并不会立即使文档可检索。须通过详情或等待工具确认 `SUCCESS` 后，才能认为切片或索引就绪。任务接口以当前 G1brain 网页为依据；插件未开放任务删除和清理。
- Office 提取保留可读正文与表格，不保留页面版式、图表、图片或 OCR。Excel 公式使用已保存的缓存结果，或显示未计算的公式；不执行公式、宏或外部引用。旧版 DOC、PDF 与 PowerPoint 文件须先转换为支持的格式，才能由这些文件工具读取或上传。加密或损坏的 Office 文件会明确报错。文档库中已有乱码不会自动修复或覆盖。
- 会话绑定后目标固定；切换资源需要新建会话。全局发现与检索工具可查询宿主配置身份能够访问的任意集合，但不能修改数据。
- 通过环境变量提供的 OAuth 凭据尚未与其他宿主插件及未来子进程隔离；在实现专用凭据传递前只能使用开发凭据。
- Excel 分类采取保守规则，不推断业务结构。含义不明的工作表需走文档处理或人工整理。数字单元格在客户端读取前可能已经丢失精度，长编号和精确小数应保存为文本。表格集合不能代替生产身份认证、跨设备上传去重或自动逐行映射本体。

<a id="dev-note"></a>
### 开发备注

无。
