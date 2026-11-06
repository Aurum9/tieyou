# 卡牌数据构建

需要 Python 3.10+；联网刷新使用 `requests`（`python -m pip install requests`）。构建和测试使用 Python 标准库。

```powershell
python app/scripts/refresh_catalog_sources.py
python app/scripts/build_catalog.py --freeze-date 2026-11-03
python -m unittest discover -s app/tests -p 'test_catalog_*.py' -v
```

刷新脚本从公开 Scryfall bulk API 与 magic-cards-zhs GitHub release 获取快照，使用 gzip JSONL 流式读取，核对下载长度与社区发布的 SHA-256。请求有连接、读取和总下载时限；不读取账户、密钥或旧项目凭据。`.cache/` 为可重新下载的本机快照，已被应用的 `.gitignore` 排除。成功下载后才绑定该文件的来源日期，失败的刷新不会把旧缓存标成新日期。

离线构建读取本机缓存；尚未刷新时可回退到旧万智牌 Agent 项目的只读原始快照。旧项目绝不写入。本地源码已包含完整静态构建产物，运行网页无需安装 Python 或访问旧项目。

力量、防御力与 EDHREC 排名由 `search-metadata.json` 单独补充，按同一冻结 Oracle ID 和牌面名称精确绑定，保留翻译分片原值。完整构建会自动生成；仅补充检索元数据可运行 `python app/scripts/build_search_metadata.py`。生成器要求原始快照日期与当前 manifest 完全一致；更新排名需要先正式刷新数据快照。

卡池按实际已发售实体印刷判定。Oracle 代表对象可能是 MTGO 版本或未来重印，不能据此删掉既有实体牌。默认版本 ID 与画面展示的系列、编号和图片保持一致。版本范围覆盖当前默认语言批量数据与社区已有映射，暂未下载全部语言印刷。

中文按 Oracle ID 与英文牌面名称精确匹配，逐面保留来源、原始阶段和英文基线哈希。缺失为空；源于上游 GPT 的译文标记 `upstreamAI: true`、`reviewStatus: unreviewed`。英文基线匹配只代表未观察到文字变化，不能证明翻译正确或经过人工复核。

已知导出问题为重复的引号转义。脚本仅对标准 JSON 解析失败的行尝试受控修复，并要求修复后完整解析成功。`dist/data/source-repair-audit.json` 索引每条原始修复/失败行，保留文件名、行号与原文 SHA-256。换行按已知导出规则规范化；上游 `CARDNAME` 置换为该牌面的真实中文名。功能标签来自 Scryfall Oracle Tags，按真实父级图扩展，保留原始 slug 与别名。

覆盖率、待复核、缺译和快照来源见 `dist/data/coverage-report.md`、`coverage-report.json` 与 `manifest.json`。中文数据授权及改编说明见 `dist/data/DATA-LICENSE.md`。

经核实的少量译文纠错可存放于 `scripts/translation-overrides.json`，构建时自动加载；也可通过 `--overrides 路径` 指定。结构为 `{"schemaVersion":1,"overrides":[...]}`，每条包含 `oracleId`、`faceName`、`source`、`version`、`oracleText`、`originalText`、`translatedText`、`reason`。仅对指定牌面应用；英文全文或原译文与冻结快照不匹配、重复条目或目标缺失时停止构建，要求重新复核。原始 `source`、`sourceStage` 保持，修订来源、版本、原译文与原因记录到 `translation.override`，复核状态为 `ai-reviewed`，不标为人工审核。未提供纠错条目时不会生成新译文。
