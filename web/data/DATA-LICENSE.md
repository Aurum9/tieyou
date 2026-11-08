# 数据来源与修改说明

中文文字来自 [HeliumOctahelide/magic-cards-zhs](https://github.com/HeliumOctahelide/magic-cards-zhs)，原项目整合官方文本、MTGso、MTGZH 志愿者及其他来源。本工具保留每个牌面的实际来源字段，包括上游 AI 来源。

该中文数据采用 [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/)；原项目[授权文件](https://github.com/HeliumOctahelide/magic-cards-zhs/blob/main/LICENSE-CC-BY-SA.txt)。对该数据的再分发与改编应按原授权保留署名、授权与相同方式共享要求。

本工具所作修改：修复导出文件的重复引号转义、规范化换行、按实际 Oracle 牌面和印刷 ID 关联、将 CARDNAME 占位符替换为对应中文名，并添加覆盖率、来源与英文基线信息。已核实的少量译文纠错保留原译文、来源、修订原因和版本，详见 coverage-report.json。原始修复行与哈希记录在 source-repair-audit.json 索引的审计分片中。

英文卡牌字段、印刷版本与功能标签来自 [Scryfall](https://scryfall.com/docs/api/bulk-data)。各快照日期和下载链接见 manifest.json。牌图通过 Scryfall 原始图片地址展示。万智牌卡牌文字、名称与图像的相关权利属于 Wizards of the Coast 及其权利人。

试牌衍生物索引 `playtest-tokens.json` 使用相同快照与许可。它根据 Scryfall 的衍生物关联筛选牌面，合并规则相同的印刷版本，并匹配 `magic-cards-zhs` 的名称、类别及规则文字。原译文来源随衍生物保存。

本次对报告列明的少量牌面进行了 AI 语义复核与纠错，状态标为 ai-reviewed；未进行全库人工译文审核。上游原有 AI 译文保留来源及各自的复核状态。
