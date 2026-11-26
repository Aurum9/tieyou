"""Prepare an auditable localization batch; does not write to either database."""
import json
import argparse
from pathlib import Path
from collections import defaultdict, Counter

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--snapshot', type=Path, default=root / '.local/tag-translation-local-snapshot.json')
parser.add_argument('--subtypes', type=Path, default=root / '.local/tag-subtype-terms.json')
args = parser.parse_args()
snapshot = json.loads(args.snapshot.read_text(encoding='utf-8-sig'))
rows = {row['slug']: row for row in snapshot['rows']}
saved = snapshot['overrides']
children = defaultdict(list)
for row in rows.values():
    for parent in row['parentSlugs']:
        children[parent].append(row['slug'])
def descendants(slug):
    seen, pending = set(), [slug]
    while pending:
        key = pending.pop()
        if key in seen: continue
        seen.add(key); pending.extend(children[key])
    return seen

cycle = descendants('cycle') | {s for s in rows if s.startswith('cycle-')}
names = descendants('card-names')
lands = {s for s in cycle if rows.get(s, {}).get('defaultLabel') or saved.get(s, {}).get('label')}
# Preserve the established land-cycle vocabulary and its navigation ancestors.
for s in list(lands):
    pending = list(rows[s]['parentSlugs'])
    while pending:
        p = pending.pop()
        if p in cycle and p not in lands:
            lands.add(p); pending.extend(rows[p]['parentSlugs'])

editorial = {}
for line in (root / 'data/tag-localization/editorial.tsv').read_text(encoding='utf-8').splitlines():
    if not line.strip(): continue
    slug, label, description = (line.split('\t', 2) + ['', ''])[:3]
    assert slug not in editorial, slug
    editorial[slug] = (label, description)

terms = {v['value'].lower().replace(' ', '-').replace("’", "'"): v['label'] for v in json.loads(args.subtypes.read_text(encoding='utf-8')) if any('\u4e00' <= c <= '\u9fff' for c in v['label'])}
def term_lines(text):
    for line in text.strip().splitlines():
        key, value = line.split('=', 1); terms[key] = value
term_lines('''artifact=神器
battle=战役
creature=生物
enchantment=结界
instant=瞬间
sorcery=法术
land=地
planeswalker=鹏洛客
permanent=永久物
spell=咒语
nonland=非地
noncreature=非生物
nonartifact=非神器
nonenchantment=非结界
nonbasic-land=非基本地
basic-land=基本地
legendary=传奇
historic=史迹
snow=雪境
colored=有色
colorless=无色
multicolor=多色
monocolor=单色
multicolored=多色
monocolored=单色
color=颜色
white=白色
blue=蓝色
black=黑色
red=红色
green=绿色
token=衍生物
token-creature=衍生生物
artifact-creature=神器生物
artifact-land=神器地
enchantment-creature=结界生物
instant-sorcery=瞬间法术
ability=异能
activated-ability=起动式异能
equip-ability=佩戴异能
loyalty-ability=忠诚异能
colored-mana=有色法术力
colorless-mana=无色法术力
commander=指挥官
power=力量
toughness=防御力
mv=法术力值
any=任意牌
card=任意牌
all=全部
specific=特定牌
choose=自选类别
share=共有类别
non-share=不同类别
high-pt=高属性
high-power=高力量
high-toughness=高防御力
low-power=低力量
low-toughness=低防御力
high-mv=高法术力值
low-mv=低法术力值
tapped=横置
untapped=竖置
flying=飞行
first-strike=先攻
double-strike=连击
triple-strike=三连击
haste=敏捷
trample=践踏
vigilance=警戒
deathtouch=死触
lifelink=系命
menace=威慑
reach=延势
hexproof=辟邪
shroud=帷幕
indestructible=不灭
protection=保护
fear=恐惧
intimidate=威吓
shadow=次元幽影
horsemanship=马术
landwalk=地行者
forestwalk=树林行者
islandwalk=海岛行者
mountainwalk=山脉行者
swampwalk=沼泽行者
plainswalk=平原行者
townwalk=城镇行者
skulk=潜匿
defender=守军
ward=守护
prowess=灵技
daunt=无畏穿透
nimble=轻巧穿透
stalking=潜踪
fake-flying=类飞行穿透
high-flying=高空飞行
unblockable=不能被阻挡
uncounterable=不能被反击
changeling=万变
devoid=虚色
exalted=颂威
flanking=侧面攻击
banding=结合
bushido=武士道
rampage=狂暴
afflict=凌虐
regenerate=重生
undying=不息
persist=留存
poisonous=有毒
infect=侵染
toxic=剧毒
wither=干枯
annihilator=歼灭
devour=吞噬
renown=声威
vanishing=消逝
suspend=延缓
cascade=倾曳
storm=风暴
replicate=复现
conspire=协力
convoke=召集
improvise=拼造
affinity=共鸣
delve=掘穴
emerge=化生
unearth=破坟
madness=疯魔
flashback=返照
jump-start=再起
retrace=追溯
escape=逸脱
encore=返场
embalm=遗存
eternalize=永生
disturb=惊扰
foretell=预示
plot=计谋
rebound=弹回
adventure=历险
warp=曲速
mayhem=肆虐
harmonize=和声
cycling=循环
basic-landcycling=基本地循环
cycle=循环组
buyback=买回
echo=返响
cumulative-upkeep=累积维持
kicker=增幅
casualty=伤亡
riot=起事
outlast=坚忍
bloodthirst=嗜血
training=教战
unleash=脱缰
mentor=训导
evolve=进化
exploit=榨取
scavenge=食腐
dredge=发掘
modular=套件
fabricate=组构
fossilize=化石化
mobilize=动员
offspring=繁生
squad=小队
myriad=繁影
melee=搏战
undaunted=不屈
blitz=奇袭
dash=掩袭
freerunning=自由奔跑
prowl=伺机
spectacle=壮观
dethrone=废黜
frenzy=狂热
provoke=挑拨
ninjutsu=忍术
saddle=乘驾
crew=搭载
decayed=败朽
afterlife=往生
soulshift=转生
soulbond=魂系
umbra-armor=本影护甲
totem-armor=本影护甲
split-second=转瞬
ripple=涟动
epic=历传
assist=助力
demonstrate=示范
read-ahead=抢读
living-weapon=活化武器
for-mirrodin=为了秘罗地
absorb=吸收
battle-cry=战嚎
firebending=御火术
waterbending=御水术
earthbending=御土术
airbending=御气术
beam-me-up=传送
web-slinging=荡网
speed=竞速
start-your-engines=发动引擎
disguise=伪装
morph=变身
manifest=显化
manifest-dread=惧现
boast=炫威
collect-evidence=搜证
forage=觅食
craft=制作
discover=倾探
enlist=征兵
bargain=协商
backup=后援
goad=煽惑
suspect=疑犯
exert=督战
connive=筹谋
clash=比点
explore=勘察
investigate=探查
mutate=合变
phasing=时间跳跃
level-up=升级
haunt=缠身
gift=馈赠
partner=拍档
doctor-s-companion=博士伙伴
villainous-choice=反派抉择
food=食品
treasure=珍宝
clue=线索
blood=血滴
junk=废品
gold=黄金
powerstone=能量石
energy=能量
map=地图
role=角色
incubator=孵化器
lander=探地器
vibranium=振金
mutagen=突变剂
contraption=机巧
attraction=游乐设施
sticker=贴纸
name-sticker=名称贴纸
art-sticker=插画贴纸
ability-sticker=异能贴纸
p-t-sticker=属性贴纸
emblem=徽记
conspiracy=诡局
dungeon=地城
initiative=先制
ring=魔戒
curse=诅咒
rune=符文
plan=计划
planet=行星
town=城镇
spacecraft=太空船
equipment=武具
aura=灵气
arcane=古咒
lesson=课程
trap=陷阱
room=房间
shrine=祭祠
case=案件
class=职业
omen=预兆
locus=处所
cave=洞窟
sphere=球体
urza-s=克撒
wastes=荒野
creatureland=变人地
basic=基本地
exile=放逐区
graveyard=坟墓场
library=牌库
hand=手牌
command-zone=统帅区
battlefield=战场
top=牌库顶
bottom=牌库底
pp=加一加一
mm=减一减一
pt=力量防御力
charge=充电
oil=烁油
time=时间
fade=消退
loyalty=忠诚
shield=盾
lore=学问
stun=晕眩
keyword=关键字
aesthetic=标记
creature-type=生物类别
land-type=地类别
spells=咒语
artifacts=神器
creatures=生物
enchantments=结界
tokens=衍生物
equipment-legendary=传奇武具
creature-dragon=龙生物
outlaw=恶徒
tantrum=闹脾气
unstoppable=阻挡者不能造成伤害
relentless=连击成长
super-haste=超级敏捷
thoughtweft=心灵纽带
double-team=夹攻
teamwork=团队合作
banana=香蕉
bobblehead=摇头娃娃
communicator=通讯器
power-up=强化升级
pin=徽章
chorus=合唱
boon=恩赐
dimension=维度
playtest=测试牌
full-hand=多手牌
no-flying=无飞行
solo-attack=独攻
target=成为目标
blocker=阻挡者
attacker=攻击者
dice=掷骰
vote=投票
exiling=放逐
counterspell=康
burn=烧
copy=复制
bounce=回手
tuck=塞牌库
mill=磨
theft=偷取
sneak=偷袭
tutor=导师
damage-prevention=防止伤害
type-change=改变类别
leaves-creature=生物离场
land-graveyard=坟墓场地牌
exile-cast=放逐区施放
graveyard-cast=坟墓场施放
library-cast=牌库施放
nonhand-cast=非手牌施放
off-turn-cast=非己回合施放
face-down-cast=牌面朝下施放
free-spell=免费咒语
etb=进场触发
shuffle=洗牌
activation=起动异能
storm-count=风暴数
life-payment=支付生命
non-wall=非墙
non-human=非人类
non-dragon=非龙
non-elf=非妖精
non-spirit=非精怪
non-zombie=非灵俑
non-choose=非所选类别
non-borg=非博格人
non-assassin=非杀手
non-god=非神
landfall=地落
reanimation=掘坟
roles=角色
lands=地
domain=领土
devotion=献力
attacking=攻击
pt-counters=属性指示物
noncreature-tokens=非生物衍生物
color-share=同色
color-non-share=异色
color-every=五色齐全
color-each=各色
color-choose=自选颜色
multicolor-pair=双色
multicolor-trio=三色
face-down=牌面朝下
token-creature=衍生生物
name=名称
dfc=双面牌''')

term_lines('''flash=闪现
proliferate=增殖
transform=转化
hybrid=混血
splice=通联
extort=敲诈
miracle=奇迹
sunburst=辉映
ingest=噬体
awaken=醒转
poison=中毒
fight=互斗
self-burn=自烧
vanilla=白板
augment=增强
host=宿主
party=冒险团队
allies=伙伴
knights=骑士
birds=鸟
cats=猫
citizens=市民
daleks=戴立克
humans=人类
outlaws=恶徒
phyrexians=非瑞人
slivers=裂片妖
spirits=精怪
caves=洞窟
towns=城镇
army=军队
klingon=克林贡人
eldrazi-scion=奥札奇孽裔
eldrazi-spawn=奥札奇后裔
serf=农奴
servo=伺服机
balloon=气球
blinkmoth=闪光蛾
camarid=卡马利
caribou=驯鹿
nautilid=鹦鹉螺人
pentavite=五节飞虫
prism=棱镜
scion=孽裔
sculpture=雕塑
shrimp=虾
teddy-bear=泰迪熊
tentacle=触手
transformer=变形金刚
tribble=曲波
reveler=狂欢客
counters=指示物
mm-counter=减一减一指示物
player=牌手
self=自身
random=随机
fairy=仙灵
instant-sorcery=瞬间或法术
fish=鱼
book=书本
sorcerer=术士
guardian=守卫
monster=怪兽
lycanthrope=兽化人
ship=船
phantasm=幻影
bodyguard=保镖
enchantress=结界师
undead=亡灵
fungusaur=菌兽
townsfolk=镇民
counter=指示物
plunder=牺牲抓牌
mulch=翻牌入坟
seek=寻找''')
for s, (label, _) in editorial.items():
    terms[s] = label

# Prefer the user's established vocabulary for functional parent tags.
for s, row in rows.items():
    label = saved.get(s, {}).get('label') or row['defaultLabel']
    if label: terms[s] = label

rare_exclusions = {line.strip() for line in (root / 'data/tag-localization/rare-editorial-exclusions.txt').read_text(encoding='utf-8').splitlines() if line.strip() and not line.startswith('#')}
for slug in rare_exclusions:
    assert slug in rows and rows[slug]['cardCount'] <= 10, slug

pw = dict(x.split('=') for x in '''jace=杰斯 chandra=茜卓 bolas=波拉斯 liliana=莉莲娜 gideon=基定 garruk=贾路 nissa=妮莎 ajani=阿耶尼 teferi=泰菲力 tezzeret=泰兹瑞 tyvar=泰瓦 vivien=薇薇安 vraska=瓦丝卡 yanling=沐燕灵 angrath=安戈斯 ashiok=安梭苛 basri=巴席利 domri=多密 dovin=多温 elspeth=艾紫培 huatli=华特莉 lukka=卢卡 oko=瓯柯 ral=拉尔 rowan=萝婉 sarkhan=萨坎 tamiyo=多美代 ugin=乌金 yanggu=江旸谷 davriel=达夫黎'''.split())

def phrase(s):
    if s in terms: return terms[s]
    if s.startswith('non-'):
        t = phrase(s[4:]); return '非' + t if t else None
    if s.startswith('pw-'): return pw.get(s[3:])
    if s.startswith('basic-'):
        t = phrase(s[6:]); return '基本' + t if t else None
    if s.endswith('-s') and s[:-2] in terms: return terms[s[:-2]]
    # Longest valid vocabulary segments; do not translate unknown fragments.
    parts = s.split('-')
    for n in range(len(parts)-1,0,-1):
        a, b = '-'.join(parts[:n]), '-'.join(parts[n:])
        if a not in terms: continue
        rest = phrase(b)
        if rest:
            if a in ['creature','artifact','enchantment','land','planeswalker','permanent']:
                return rest if (b in terms or b.startswith('basic-')) and (a in ['creature','artifact','enchantment','land'] and b not in ['green','blue','white','black','red','colorless','legendary','power','toughness','noncreature','colored']) else rest + terms[a]
            return terms[a] + rest
    return None

def translate(row):
    s = row['slug']
    if s in editorial: return (*editorial[s], '逐条释义')
    if s in terms and any('\u4e00' <= c <= '\u9fff' for c in terms[s]): return terms[s], '', '既有术语'
    def result(label, description): return label, description, '同分支统一术语'
    for prefix, suffix, template in [
        ('seek-', '寻找', '从牌库中随机取得符合{t}条件的牌。'),
        ('conjure-', '变出', '在游戏中直接创建符合{t}条件的牌。'),
        ('keyword-errata-', '关键字勘误', '原有文字后来更新为{t}关键字。'),
        ('type-addition-', '类别追加勘误', '规则勘误后追加了{t}类别。'),
        ('type-errata-specific-', '类别归并勘误', '原有更细分的类别被统一为{t}。'),
        ('type-errata-', '类别勘误', '规则勘误涉及原有的{t}类别。'),
        ('creature-type-', '旧生物类别', '曾使用{t}这一生物类别的牌。'),
        ('repeatable-', '', '可重复提供{t}效果。'),
        ('gives-', '', '给予其他物件或牌手{t}能力。'),
        ('gains-', '', '自身具有或可以获得{t}能力。'),
        ('removes-', '', '使物件失去{t}。'),
        ('synergy-', '协同', '与{t}相关的资源、状态或行为配合。'),
        ('hate-typal-', '针对', '针对{t}生物。'),
        ('hate-', '针对', '针对{t}相关的资源、状态或策略。'),
        ('typal-', '部族', '与{t}生物类别配合。'),
        ('regrowth-', '再生新芽', '将坟墓场中的{t}牌移回手牌。'),
        ('recursion-', '回收', '重新利用坟墓场中的{t}牌。'),
        ('reanimate-', '掘坟', '将{t}从坟墓场移回战场。'),
        ('restock-', '洗回', '将坟墓场中的{t}牌移回牌库。'),
        ('impulse-', '冲动', '查看牌库顶若干张牌，从中取得符合{t}条件的牌。'),
        ('tutor-', '导师', '从牌库中搜寻符合{t}条件的牌。'),
        ('affinity-for-', '共鸣减费', '根据{t}相关资源减少费用。'),
        ('cost-reducer-', '减费源', '减少{t}相关咒语或异能的费用。'),
        ('sacrifice-outlet-', '牺牲源', '提供牺牲{t}的能力。'),
        ('discard-outlet-', '弃牌源', '提供从手牌弃掉{t}牌的能力。'),
        ('graveyard-fuel-', '坟墓场驱动', '从坟墓场放逐{t}牌来支付费用。'),
        ('tap-fuel-', '横置驱动', '横置{t}来支付费用。'),
        ('counter-fuel-', '指示物驱动', '移去{t}指示物来支付费用。'),
        ('copy-', '复制', '复制{t}。'),
        ('sneak-', '偷袭', '将{t}从手牌直接放进战场。'),
        ('rescue-', '救援', '将自己操控的{t}移回手牌。'),
        ('theft-', '偷取', '从对手处取得{t}的操控权或使用权。'),
        ('tapper-', '横置', '横置{t}。'),
        ('untapper-', '重置', '重置{t}。'),
        ('flicker-', '云移', '放逐{t}，随后使其回到战场。'),
        ('animate-', '变人', '使{t}成为生物。'),
        ('counterspell-', '康', '反击{t}咒语。'),
        ('freeze-', '冻结', '让{t}在接下来若干次重置步骤中不能重置。'),
        ('lockdown-', '锁定', '使{t}持续保持横置。'),
        ('damage-prevention-', '防止伤害', '防止对{t}造成的伤害。'),
        ('protects-', '保护', '保护你的{t}免受干扰。'),
    ]:
        if not s.startswith(prefix): continue
        tail = s[len(prefix):]; t = phrase(tail)
        if not t: return None
        if prefix == 'repeatable-': return result('可重复' + t, template.format(t=t))
        if prefix == 'gives-': return result('给予' + t, template.format(t=t))
        if prefix == 'gains-': return result('获得' + t, template.format(t=t))
        if prefix == 'removes-': return result('移除' + t, template.format(t=t))
        if prefix == 'copy-': return result('复制' + t, template.format(t=t))
        if prefix == 'protects-': return result('保护' + t, template.format(t=t))
        if prefix == 'counter-fuel-': return result(t + suffix, template.format(t=t))
        if prefix == 'graveyard-fuel-': return result(t + '坟墓场驱动', template.format(t=t))
        if prefix in ['tapper-','untapper-','freeze-','lockdown-']: return result(suffix + t, template.format(t=t))
        description = template.format(t=t).replace('牌牌', '牌').replace('生物生物', '生物').replace('能力能力', '能力')
        return result(t + suffix, description)
    if s.endswith('-counter'):
        t = phrase(s[:-8])
        if t: return result(t + '指示物', '放置或使用' + t + '指示物。')
    if s.startswith('roll-d') and s[6:].isdigit(): return result('掷' + s[6:] + '面骰', '掷' + s[6:] + '面骰。')
    if s.endswith('fall'):
        t = phrase(s[:-4])
        if t: return result(t + '落', t + '进场时触发。')
    return None

seen, order = set(), []
def walk(s):
    if s in seen: return
    seen.add(s); order.append(s)
    for child in sorted(children[s], key=lambda k:(-rows[k]['cardCount'],k)): walk(child)
for s in sorted(rows, key=lambda k:(-rows[k]['cardCount'], k)): walk(s)

results, unresolved = [], []
for i, s in enumerate(order):
    row = rows[s]; original = saved.get(s)
    current = dict(original) if original else {'label':row['defaultLabel'],'visible':True,'descriptionZh':'','includeInAnalysis':False}
    reason = ''
    if s in names: current['visible'] = False; reason = '卡名与文字游戏'
    elif s in cycle and s not in lands: current['visible'] = False; reason = '普通循环标记'
    elif original and not original['visible']: reason = '保留人工隐藏'
    elif s in rare_exclusions: current['visible'] = False; reason = '低数量且偏考据或特殊玩法'
    else:
        translated = translate(row)
        if translated:
            label, description, reason = translated
            if not current['label']: current['label'] = label
            if not current['descriptionZh']: current['descriptionZh'] = description
        elif not current['label']:
            unresolved.append(row)
    if current != original:
        results.append({'order':i,'slug':s,'cardCount':row['cardCount'],'parentSlugs':row['parentSlugs'],'reason':reason,'before':original,'after':current})

out = {'sourceRevision':snapshot['revision'],'rules':{'order':'descending-card-count-depth-first','preserveExistingLabels':True,'preserveExistingAnalysis':True},'changes':results}
(root / '.local/tag-translation-plan.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
(root / '.local/tag-translation-unresolved.json').write_text(json.dumps(unresolved,ensure_ascii=False,indent=2),encoding='utf-8')
print('Prepared', len(results), 'entries; unresolved:',len(unresolved),'; reasons:',dict(Counter(c['reason'] for c in results)))
for row in unresolved: print(f"{row['slug']}|{row['cardCount']}|{row['description']}")
if unresolved:
    raise SystemExit('Resolve every visible untranslated tag before exporting.')
future = dict(saved)
future.update({c['slug']:c['after'] for c in results})
decisions = {c['slug']:c['reason'] for c in results}
for s, value in saved.items():
    assert not value['label'] or future[s]['label'] == value['label'], s
    assert not value['descriptionZh'] or future[s]['descriptionZh'] == value['descriptionZh'], s
    assert future[s]['includeInAnalysis'] == value['includeInAnalysis'], s
    assert value['visible'] or not future[s]['visible'], s
bundle = {
    'version': 1, 'preparedOn':'2026-11-26', 'sourceRevision':snapshot['revision'],
    'rules':out['rules'], 'protectedLandCycles': sorted(lands), 'preservedOverrides':saved,
    'summary': {
        'total':len(order), 'visible':sum(v['visible'] for v in future.values()),
        'newLabels':sum(not saved.get(s,{}).get('label',rows[s]['defaultLabel']) and bool(v['label']) for s,v in future.items()),
        'newDescriptions':sum(not saved.get(s,{}).get('descriptionZh') and bool(v['descriptionZh']) for s,v in future.items()),
        'decisions':dict(Counter(decisions.values()))
    },
    'entries':[{'slug':s, **future[s], 'cardCount':rows[s]['cardCount'], 'parentSlugs':rows[s]['parentSlugs'], 'decision':decisions.get(s,'保留人工设置')} for s in order]
}
(root / 'data/tag-localization/2026-11-26.zh-CN.json').write_text(json.dumps(bundle,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
