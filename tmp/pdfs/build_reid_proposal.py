from pathlib import Path
import sys, html
ROOT=Path.cwd()
sys.path.insert(0,str(ROOT/'tmp/pdfs/deps'))
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Flowable
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.enums import TA_LEFT
pdfmetrics.registerFont(TTFont('CN','C:/Windows/Fonts/simsun.ttc',subfontIndex=0))
pdfmetrics.registerFont(TTFont('CNBold','C:/Windows/Fonts/simhei.ttf'))
pdfmetrics.registerFontFamily('CN',normal='CN',bold='CNBold',italic='CN',boldItalic='CNBold')
NAVY=colors.HexColor('#153047'); TEAL=colors.HexColor('#087F8C'); INK=colors.HexColor('#263746'); GRAY=colors.HexColor('#637484'); LIGHT=colors.HexColor('#EDF5F6')
styles={
 'body':ParagraphStyle('body',fontName='CN',fontSize=10.5,leading=17,textColor=INK,spaceAfter=8,wordWrap='CJK'),
 'small':ParagraphStyle('small',fontName='CN',fontSize=9,leading=14,textColor=INK,spaceAfter=5,wordWrap='CJK'),
 'h1':ParagraphStyle('h1',fontName='CNBold',fontSize=21,leading=29,textColor=NAVY,spaceAfter=15,wordWrap='CJK'),
 'h2':ParagraphStyle('h2',fontName='CNBold',fontSize=12.5,leading=19,textColor=TEAL,spaceBefore=9,spaceAfter=7,wordWrap='CJK'),
 'title':ParagraphStyle('title',fontName='CNBold',fontSize=27,leading=39,textColor=NAVY,spaceAfter=18,wordWrap='CJK'),
 'kicker':ParagraphStyle('kicker',fontName='CNBold',fontSize=10,leading=16,textColor=TEAL,spaceAfter=12),
 'cell':ParagraphStyle('cell',fontName='CN',fontSize=9.3,leading=14.5,textColor=INK,wordWrap='CJK'),
 'th':ParagraphStyle('th',fontName='CNBold',fontSize=9.5,leading=14,textColor=colors.white,wordWrap='CJK'),
}
story=[]
def p(s,sty='body'): return Paragraph(s,styles[sty])
def add(s,sty='body'): story.append(p(s,sty))
def h(s): add(s,'h2')
def bullet(s): add('• '+s)
def table(headers,rows,widths):
 data=[[p(x,'th') for x in headers]]+[[p(str(x),'cell') for x in row] for row in rows]
 t=Table(data,colWidths=widths,repeatRows=1,hAlign='LEFT')
 t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),NAVY),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F3F7FA')]),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),('LINEBELOW',(0,-1),(-1,-1),.5,colors.HexColor('#CAD8E2'))]))
 story.append(t);story.append(Spacer(1,9))
def box(title,text):
 t=Table([[p(title,'h2')],[p(text)]],colWidths=[491]);t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),LIGHT),('BOX',(0,0),(-1,-1),.5,colors.HexColor('#D0E3E5')),('LEFTPADDING',(0,0),(-1,-1),13),('RIGHTPADDING',(0,0),(-1,-1),13),('TOPPADDING',(0,0),(-1,0),4),('BOTTOMPADDING',(0,-1),(-1,-1),9)]));story.append(t);story.append(Spacer(1,10))
def page(num,title):
 if story:story.append(PageBreak())
 add('本科毕业设计方案草案  /  '+num,'kicker');add(title,'h1')
class Pipeline(Flowable):
 def __init__(self): Flowable.__init__(self);self.width=491;self.height=155
 def draw(self):
  c=self.canv
  for y,labels in [(95,['离线图库','图像预处理','特征提取','特征缓存']), (20,['查询图片','同一特征模型','相似度排序','Top-K 结果'])]:
   for i,label in enumerate(labels):
    x=i*125;c.setFillColor(LIGHT if i<3 else colors.HexColor('#D7EDEF'));c.setStrokeColor(colors.HexColor('#B8CDD5'));c.roundRect(x,y,111,40,5,fill=1,stroke=1);c.setFillColor(NAVY);c.setFont('CNBold',11);c.drawCentredString(x+55.5,y+15,label)
    if i<3:
     c.setStrokeColor(TEAL);c.line(x+113,y+20,x+123,y+20);c.line(x+120,y+23,x+123,y+20);c.line(x+120,y+17,x+123,y+20)
  c.setFont('CN',9);c.setFillColor(GRAY);c.drawString(0,76,'图库特征提前提取；查询与图库必须使用相同模型权重及预处理。')
  c.setStrokeColor(TEAL);c.line(430,95,430,80);c.line(430,80,305,80);c.line(305,80,305,62);c.line(302,65,305,62);c.line(308,65,305,62)
# 1
add('毕业设计 / 选题与开题准备','kicker')
add('基于相似度学习的\n行人搜索系统'.replace('\n','<br/>'),'title')
add('选题定位 · 研究方案 · 技术路线 · 实施计划','h2')
add('计算机科学与技术本科毕业设计讨论稿  |  版本 1.0  |  2026 年 9 月 24 日','small')
story.append(Spacer(1,15))
box('建议提交导师讨论的题目','<b>《基于深度特征与相似度学习的行人图像检索系统设计与实现》</b><br/>如果确认必须从完整场景图中自动定位目标，再调整为：<br/><b>《融合行人检测与相似度学习的行人搜索系统设计与实现》</b>。')
add('本课题拟以公开行人数据集和预训练重识别模型为基础，研究同一身份在不同摄像头、姿态及背景条件下的图像匹配问题，构建能够上传查询图像、返回候选结果并展示实验指标的检索系统。')
table(['拟定项目','当前建议'],[
 ['核心研究','固定深度特征下的轻量相似度学习，以及效果与计算成本的比较。'],
 ['基础路线','Market-1501 + OSNet / Torchreid + 余弦基线 + 可训练匹配模块。'],
 ['增强路线','基础实验稳定后，选择 CLIP-ReID 验证方法对另一种特征的适用性。'],
 ['成果形式','可运行系统、训练与评估代码、模型及配置、实验记录、毕业论文和答辩材料。'],
 ['设备边界','使用现成图片，不依赖摄像头等专用设备；需要时租用云端 GPU。'],
], [92,399])
add('文档定位：用于选题和开题讨论，不是已经完成的研究报告。具体时间、格式、参考文献数量及创新要求，以学院文件和导师意见为准；文中不预设准确率提升或学校验收结论。','small')
h('阅读导航')
add('第 2 页：选题与开题流程；第 3-4 页：技术路线与算法；第 5-6 页：数据和实验；第 7-8 页：系统、设备与计划；第 9-10 页：开题表述、论文目录、参考资料。','small')
#2
page('01','从选题到开题，怎么推进')
add('开题的关键是回答四个问题：研究什么、为什么值得做、准备用什么方法、在现有时间和设备条件下能否完成。先确认范围，再把研究任务写进学院模板。')
table(['阶段','主要工作','应形成的材料'],[
 ['1. 明确选题','与导师确认图像检索还是整图搜索；确定算法工作量、系统要求及时间节点。','题目、研究对象、必做与可选边界'],
 ['2. 文献调研','按特征提取、度量学习、行人搜索三类阅读；记录方法、数据、指标、局限和可复用代码。','文献对照表及主要参考资料'],
 ['3. 可行性预实验','取得数据和权重，跑通预训练模型检索及官方评估；确认环境与单次实验耗时。','真实基线结果、检索截图、运行日志'],
 ['4. 编写开题报告','写清背景、研究现状、问题、方法、实验、系统、进度和预期成果。','开题报告初稿、技术路线图'],
 ['5. 导师修改与开题','按学院流程提交材料、制作汇报；解释研究点与工作量，记录修改意见。','开题稿、汇报材料、修订清单'],
 ['6. 开题后实施','按照里程碑训练、实验、开发、写作；中期检查后保留充足整合时间。','阶段成果、中期材料、论文及答辩成果'],
],[69,226,196])
h('本选题的合理边界')
bullet('<b>必做：</b>已裁剪行人图像检索；至少一个可训练算法模块；规范基线、对比和消融；结果展示与实验记录。')
bullet('<b>可选：</b>第二种特征模型、第二个数据集、整图检测入口、较大图库的索引检索。每项先评估收益和剩余时间。')
bullet('<b>本轮不纳入：</b>实时多摄像头跟踪、换装识别、文本找人及检测与重识别的联合端到端训练。')
box('开题前的小目标','先拿出一个真实案例：输入一张查询图片，返回 Top-10 结果，并通过规范脚本输出 Rank-1 与 mAP。这个预实验能帮助导师判断可行性，但不等于已经完成算法研究。')
#3
page('02','技术路线与模型如何分工')
story.append(Pipeline())
table(['名称','它是什么','本课题中的角色'],[
 ['PyTorch','深度学习框架','加载模型、计算特征、训练匹配模块。'],
 ['OSNet','行人重识别网络','起步特征模型；优先复现轻量基线。[2][3]'],
 ['Torchreid','基于 PyTorch 的重识别工具库','提供数据加载、模型、训练与评估工具；它不是另一种网络。[2]'],
 ['CLIP-ReID','基于视觉语言预训练的重识别方法','进阶特征模型，原方法有两阶段训练；本课题可先使用已有权重。[4]'],
 ['Faster R-CNN','目标检测模型','扩展时定位整图中的行人；自身不完成身份匹配。[5]'],
 ['相似度模块','本课题拟研究的小型模型','输入两张图片的特征，输出匹配分数，与余弦基线比较。'],
],[91,143,257])
h('建议采用渐进式实现')
add('<b>第一步：</b>在 OSNet 上跑通数据、特征、排序、评估流程。<b>第二步：</b>在固定特征上训练匹配模块，明确研究结果。<b>第三步：</b>如果基础流程稳定，再在 CLIP-ReID 特征上重复对比；不要求两个模型全部重新训练。')
add('如果最终选择整图搜索：在上述流程前增加“检测行人 → 裁剪 → 提取特征”。主实验仍先使用标准裁剪图控制变量；完整搜索效果另外使用 PRW 等场景数据验证，不能用裁剪图检索分数代替整图搜索分数。[6]')
box('模型权重需要区分','通用 ImageNet / CLIP 预训练权重，与已经在行人重识别数据集上训练过的权重并不相同。下载时记录模型结构、训练数据、图像尺寸和权重来源。采用公开权重不代表完成了自己的训练工作。')
#4
page('03','研究点：可训练的相似度模块')
h('拟研究的问题')
add('对于同一组固定行人特征，学习特征各维度之间的匹配关系，能否比直接使用余弦相似度取得更好的检索效果？这种改善是否值得增加的参数量和查询耗时？本问题是待实验检验的假设。')
h('基线与候选方法')
add('设两张行人图片经过同一编码器得到特征 u、v，并进行 L2 归一化。余弦基线直接计算 u 与 v 的内积，再按分数从高到低排序。')
box('轻量匹配模块的起步形式','构造配对特征：z = concat(abs(u - v), u * v)<br/>线性分数：s = w^T z + b<br/>训练输出：p = sigmoid(s)<br/>其中 abs 表示逐元素绝对值，* 表示逐元素乘积，concat 表示拼接；p 用于训练损失，检索可按 s 排序。')
add('若单张图像特征维度为 d，该线性模块只需 2d + 1 个可训练参数。它提供了易于实现和分析的起点；若效果不足，再将线性层替换为小型多层感知机，并检查是否出现过拟合。匹配分数不能直接宣传为已经校准的“同一人概率”。')
h('具体训练流程')
for s in [
 '冻结特征编码器，使用固定预处理提取并缓存训练集特征；“冻结”表示不更新编码器参数。',
 '用身份标签构建正样本对（同一个人）和负样本对（不同人），优先包含不同摄像头的正样本。',
 '按批次抽取样本对，使用二元交叉熵等损失训练匹配模块；不枚举全部图片两两组合。',
 '在验证数据上选择学习率、正负比例、训练轮数和正则化；需要时加入适量难负样本，并与随机负样本比较。',
 '固定配置后，在测试查询与图库上评估，与同一编码器的余弦基线比较。']:
 bullet(s)
h('哪些能写成自己的工作')
add('可写的工作包括：方法选择依据、匹配模块实现、采样策略分析、消融与效率实验，以及系统集成。差值、乘积特征和度量学习本身是已有思路，不能直接声称为原创算法；是否构成学校认可的研究深度，需在开题时与导师确认。','small')
#5
page('04','数据集、划分与评估规范')
table(['数据','拟定用途','获取与处理'],[
 ['Market-1501','必做：裁剪图重识别','使用作者页面下载，沿用标准 train / query / gallery 划分。[1]'],
 ['CUHK03','可选：第二数据集验证','官方提供人工框与检测框版本；选择一种协议并明确记录。[7]'],
 ['PRW','仅在整图搜索扩展时使用','包含场景图、行人框和身份信息，按其搜索协议评估。[6]'],
],[91,151,249])
h('Market-1501 的数据怎么用')
add('训练目录 bounding_box_train 有 12,936 张图片；query 有 3,368 张查询图；bounding_box_test 有 19,732 张图库图片。训练模块使用训练数据，最终检索评估使用查询与图库；二者职责不同。[1]')
h('最需要避免的三个问题')
bullet('<b>泄漏测试数据：</b>不得把测试身份、测试标签或测试结果用于训练、难样本挖掘和反复挑选参数。图库缓存特征属于推理，不等于允许用测试标签训练。')
bullet('<b>验证集不独立：</b>建议从训练身份中划出验证身份。若所用公开编码器已经见过这些身份，就只能称为匹配模块层面的验证；若要严格验证整个流程，应使用未见过验证身份的权重，或按新划分重新训练编码器，并披露协议。')
bullet('<b>评估规则不一致：</b>使用数据集规定的无效样本与同摄像头同身份过滤规则。不要直接用普通分类准确率或忽略过滤的排序程序替代标准 ReID 评估。')
h('Rank-1 与 mAP 的含义')
add('<b>Rank-1：</b>有效查询中，排名第一的有效检索结果身份正确的比例。<b>mAP：</b>每个查询的平均精度 AP 再取平均，反映多张正确图片是否排得靠前。两者是评价指标，不需要额外训练。[1][2]')
add('简化示例：某查询有 3 张相关图片，分别排在第 1、4、5 位，则 AP = (1/1 + 2/4 + 3/5) / 3 = 70%；这一次的 Rank-1 判断为正确。正式评估还要遵守前述过滤规则。')
box('结果记录原则','保存数据版本、划分文件、模型权重来源、代码版本、随机种子和评估配置。若进行跨数据集测试，区分“完全不微调”与“在目标训练集上微调”，不能混为同一种泛化实验。')
#6
page('05','实验怎么设计，论文才有证据')
add('实验以回答研究问题为目的。所有表格在真正运行后填入实测结果；开题阶段仅写设计，不预填“预期提升百分比”。')
table(['编号','实验设计','回答的问题'],[
 ['E1 基线','固定 OSNet 特征 + 余弦相似度。','基础检索效果、耗时和复现差异是什么？'],
 ['E2 主对比','相同特征 + 训练后的配对匹配模块。','性能变化是否来自相似度学习？'],
 ['E3 消融','仅差值、仅乘积、两者拼接；其余设置固定。','不同配对特征是否有实际贡献？'],
 ['E4 训练策略','随机负样本与适量难负样本；训练预算保持可比。','采样策略是否有助于泛化？'],
 ['E5 可选模型验证','CLIP-ReID + 余弦，与同一 CLIP-ReID + 匹配模块对比。','模块效果是否依赖某一种编码器？'],
 ['E6 系统效率','统计特征提取、打分排序、总查询耗时和资源占用。','准确率与使用成本如何权衡？'],
],[76,232,183])
h('最少需要留下的结果')
bullet('一张主对比表：模型、匹配方式、Rank-1、mAP、单次查询耗时。')
bullet('一张消融表：模块组成与采样设置；可选附训练损失曲线。')
bullet('成功与失败案例图：相似衣着、姿态差异、背景干扰、遮挡等。')
bullet('对最终主要训练配置，在预算允许时采用 3 个随机种子，报告均值和波动；若只有一次实验，明确说明。')
h('公平比较的控制条件')
add('E1 与 E2 必须共用编码器权重、图像预处理、查询/图库、评估过滤规则。模型间对比还应披露训练数据及输入尺寸差异。耗时测试注明设备、图库大小、批量大小、是否预缓存特征和预热方式。')
box('如果没有提升，怎么办','先检查实现、协议和训练过拟合，再分析模块是否确实不适合当前特征。负结果也可形成有价值的实验分析，但毕业要求由导师决定。不要为得到提升而反复使用测试集调参，也不要用未经验证的数字填表。')
#7
page('06','系统功能、技术栈与设备')
table(['模块','拟实现内容','建议技术'],[
 ['数据与特征管理','导入图库、记录图片元数据、批量生成特征缓存。','Python、Pillow / OpenCV、NumPy'],
 ['算法服务','加载固定版本权重，预处理、提取特征、匹配和排序。','PyTorch；OSNet / CLIP-ReID'],
 ['接口与任务','上传查询图、触发检索、获取结果；耗时任务显示进度。','FastAPI；初期采用简单任务机制'],
 ['界面展示','查询图、Top-K 图片、分数、用时；模型与匹配方式切换。','Vue 3；早期验证可用 Streamlit'],
 ['数据存储','保存图像路径、配置、实验和检索记录。','SQLite + 文件目录；特征独立缓存'],
 ['实验与交付','配置、日志、曲线、结果导出、环境说明。','Git、CSV / JSON、Matplotlib'],
],[93,239,159])
h('检索策略不要一开始做复杂')
add('Market-1501 规模下优先使用向量运算或分批打分，先保证结果可核验。图库增大后再考虑 FAISS：先按向量距离召回候选，再用配对模块重排。一般配对模型不能直接当作标准余弦向量索引；采用两阶段方案时，必须报告候选数量和召回损失。')
h('设备与云端安排')
add('本地电脑负责代码、数据管理和界面；可在云端 GPU 上提取特征及训练。无需购买摄像头或采集卡。作为资源规划起点，可先试用单张 12-24 GB 显存 GPU，具体需求由模型、图像尺寸、批量和是否微调编码器决定，不能将此范围当作最低配置保证。')
add('冻结编码器、缓存特征后，小型匹配模块可尝试在 CPU 或较小 GPU 上训练。CLIP-ReID 的完整训练和微调通常需要更多资源，因此先测通一小批数据，再决定租用时长。')
box('预算与交付应如何控制','不预先承诺固定费用：先测单轮训练时间，再按“预计轮数 × 实验组数 × 重复次数”估算 GPU 小时，并计入存储与下载。保存权重和日志后及时停止计费实例。公开数据和权重应按各自条款使用、引用，不将数据集图片随项目任意再发布。')
#8
page('07','12 周实施计划与风险处理')
add('以下为相对进度示例，从正式启动起计算；不是学院规定的时间表。开题、中期检查、预答辩与正式答辩日期确认后，再映射到实际日历。')
table(['时间','工作重点','阶段验收'],[
 ['第 1-2 周','文献梳理、范围确认、数据下载、预训练检索；完成开题初稿与汇报。','能解释研究问题，并跑通一个真实检索案例。'],
 ['第 3-4 周','规范基线、身份划分、特征缓存、搭建匹配模块训练流程。','得到可重复的基线和一次完整训练记录。'],
 ['第 5-6 周','主对比、消融、采样策略实验；开展失败案例分析。','形成真实结果表，决定保留或调整的方法。'],
 ['第 7-8 周','完成后端、界面、图库导入与结果展示；准备中期材料。','系统能连续完成导入、查询、展示及记录。'],
 ['第 9 周','如时间允许，加入 CLIP-ReID 或整图检测，二者择一优先。','扩展不影响基础方案的复现与交付。'],
 ['第 10 周','固定配置，复核评估协议、关键结果和性能。','形成可追溯的最终实验材料。'],
 ['第 11-12 周','论文整合、导师修改、系统打包、演示与答辩准备。','论文、代码、说明书、演示材料齐备。'],
],[76,242,173])
h('风险与降级路线')
bullet('<b>环境或权重难复现：</b>固定仓库版本和依赖，先使用官方支持的数据与权重；CLIP-ReID 受阻时保留 OSNet 主线。')
bullet('<b>训练效果不稳定：</b>先核对标签、正负采样和评估协议；减少参数，增加正则化，避免立即更换成更复杂网络。')
bullet('<b>云端预算不足：</b>缓存特征，减少全网微调与大规模参数搜索，先完成核心 E1-E3 实验。')
bullet('<b>系统范围失控：</b>优先交付裁剪图检索；若整图检测被删除，论文题目与实验声明同步调整。')
add('建议从第 1 周开始持续写作和记录，不等系统全部完成后才补论文。每周向导师汇报：已完成内容、证据、当前问题、下周计划。','small')
#9
page('08','开题报告可用的表述草案')
h('研究目的与意义')
add('行人图像检索旨在根据给定的行人图像，从图库中检索同一身份的其他图像。由于摄像头视角、姿态、光照和背景变化，同一人的外观可能存在较大差异，而不同人的服饰可能相近。本课题拟在公开数据集上研究深度特征与可训练相似度方法，分析其检索效果与计算开销，并实现可交互的检索系统，为视觉特征学习与软件工程相结合的本科毕业设计提供实践载体。')
h('拟开展的研究内容')
add('（1）梳理行人重识别与度量学习相关方法，建立标准数据处理和评估流程；（2）复现预训练模型结合余弦相似度的检索基线；（3）构建轻量配对匹配模块，研究特征组合与样本采样的影响；（4）开展对比、消融及效率实验；（5）实现图库管理、查询、排序结果与实验记录展示。完整场景检测作为条件允许时的扩展。')
h('拟解决的问题与预期成果')
add('拟解决的问题是：固定行人特征下，配对相似度学习能否在可接受的计算开销内改善检索排序，以及如何将该方法整合为可运行系统。预期形成规范的实验流程、经验证的算法实现、系统原型和毕业论文。不预设性能提升，不将采用现有模型或模块本身视为原创贡献。')
h('毕业论文建议目录')
table(['章节','主要内容'],[
 ['第 1 章 绪论','背景、意义、国内外研究现状、问题定位和主要工作。'],
 ['第 2 章 相关技术','重识别、深度特征、相似度与度量学习、评价指标。'],
 ['第 3 章 方法设计','基线、匹配模块、训练策略、复杂度及实现细节。'],
 ['第 4 章 实验与分析','数据协议、环境、对比、消融、效率和失败案例。'],
 ['第 5 章 系统设计与实现','需求、架构、接口与数据设计、功能及系统测试。'],
 ['第 6 章 总结与展望','实际完成的工作、局限及后续研究方向。'],
],[134,357])
add('以上段落可作为开题初稿素材。正式提交时需要结合真实阅读的文献补充研究现状，并按学院模板调整措辞、章节和引用格式。','small')
#10
page('09','参考资料与导师沟通清单')
add('以下优先列出原论文及作者、框架官方入口。网页链接核对日期：2026 年 9 月 24 日；链接存在不等于已验证压缩包下载、代码安装或模型复现。','small')
refs=[
 ('[1] Zheng L, et al. Scalable Person Re-identification: A Benchmark. ICCV, 2015.','Market-1501 数据与协议','https://zheng-lab-anu.github.io/Project/project_reid.html'),
 ('[2] Zhou K, Xiang T. Torchreid: A Library for Deep Learning Person Re-Identification in PyTorch. 2019.','数据、模型与评估工具','https://github.com/KaiyangZhou/deep-person-reid'),
 ('[3] Zhou K, et al. Omni-Scale Feature Learning for Person Re-Identification. ICCV, 2019.','OSNet 原论文','https://arxiv.org/abs/1905.00953'),
 ('[4] Li S, Sun L, Li Q. CLIP-ReID: Exploiting Vision-Language Model for Image Re-Identification without Concrete Text Labels. AAAI, 2023.','CLIP-ReID 官方实现','https://github.com/Syliz517/CLIP-ReID'),
 ('[5] Torchvision 官方文档：fasterrcnn_resnet50_fpn.','Faster R-CNN 模型接口与权重','https://docs.pytorch.org/vision/main/models/generated/torchvision.models.detection.fasterrcnn_resnet50_fpn.html'),
 ('[6] Zheng L, et al. Person Re-identification in the Wild. CVPR, 2017.','PRW 数据与搜索评估','https://zheng-lab-anu.github.io/Project/project_prw.html'),
 ('[7] Li W, et al. DeepReID: Deep Filter Pairing Neural Network for Person Re-Identification. CVPR, 2014.','CUHK 系列数据集','https://www.ee.cuhk.edu.hk/~xgwang/CUHK_identification.html'),
]
for title,label,url in refs:
 add(html.escape(title),'small');add('<link href="'+html.escape(url,quote=True)+'" color="#087F8C"><u>'+label+'（点击访问）</u></link>','small')
add('继续阅读：TransReID（ICCV 2021）、KPR（ECCV 2024）；此前收集的《基于多粒度匹配的行人搜索算法》《Faster R-CNN 行人检测与再识别为一体的行人检索算法》可用于分析局部匹配、相似度设计与检测误差。正式引用前按原文核对完整作者、卷期和页码。','small')
h('下一次与导师确认这五件事')
for s in ['题目使用“图像检索”还是必须完成“整图搜索”？','冻结特征后训练匹配模块，是否满足本专业的算法工作量要求？','以 OSNet 起步、CLIP-ReID 作为增强，是否符合导师预期？','需要几个数据集、哪些对照方法，以及怎样的系统交付？','学院开题模板、各阶段日期、论文篇幅与格式要求是什么？']:
 add('□ '+s,'small')
box('最近一周可执行的起步任务','与导师确认题目和范围 → 获取 Market-1501 与合法可用的模型权重 → 跑通官方检索评估 → 建立文献表和实验记录 → 形成学院格式的开题初稿。')
# Render
out=ROOT/'output/pdf';out.mkdir(parents=True,exist_ok=True)
path=out/'行人搜索毕设_选题与开题方案草案.pdf'
class NumberCanvas(canvas.Canvas):
 def __init__(self,*args,**kw): super().__init__(*args,**kw);self.states=[]
 def showPage(self): self.states.append(dict(self.__dict__));self._startPage()
 def save(self):
  n=len(self.states)
  for st in self.states:
   self.__dict__.update(st); self.setStrokeColor(colors.HexColor('#D2DCE3'));self.line(52,48,543,48);self.setFont('CN',8);self.setFillColor(GRAY);self.drawString(52,33,'行人搜索毕业设计  |  选题与开题讨论稿');self.drawRightString(543,33,f'{self._pageNumber:02d} / {n:02d}');super().showPage()
  super().save()
def header(c,doc):
 c.setFillColor(TEAL);c.rect(52,801,32,4,fill=1,stroke=0)
 c.setFont('CN',8);c.setFillColor(GRAY);c.drawRightString(543,799,'RESEARCH PROPOSAL  /  DRAFT 1.0')
doc=SimpleDocTemplate(str(path),pagesize=(595.276,841.89),rightMargin=52,leftMargin=52,topMargin=64,bottomMargin=63,title='基于相似度学习的行人搜索系统：选题与开题方案草案',author='毕业设计方案整理',subject='本科毕业设计选题、开题、技术路线与实验计划')
doc.build(story,onFirstPage=header,onLaterPages=header,canvasmaker=NumberCanvas)
print(path)
import fitz
pdf=fitz.open(path)
print('PAGES',len(pdf))
qa=ROOT/'tmp/pdfs/reid_qa';qa.mkdir(parents=True,exist_ok=True)
for i,pg in enumerate(pdf):
 pg.get_pixmap(matrix=fitz.Matrix(1.35,1.35),alpha=False).save(qa/f'page-{i+1:02d}.png')
 print(i+1,len(pg.get_text()),pg.get_text()[:65].replace('\n',' | '))
(qa/'extracted.txt').write_text('\n\n'.join(pg.get_text() for pg in pdf),encoding='utf-8')
from PIL import Image,ImageOps,ImageDraw
thumbs=[]
for f in sorted(qa.glob('page-*.png')):
 im=Image.open(f).convert('RGB');im.thumbnail((298,422));panel=Image.new('RGB',(318,455),'#dae1e6');panel.paste(im,((318-im.width)//2,10));ImageDraw.Draw(panel).text((12,435),f.stem,fill='black');thumbs.append(panel)
for start in range(0,len(thumbs),6):
 chunk=thumbs[start:start+6];sheet=Image.new('RGB',(318*3,455*((len(chunk)+2)//3)),'white')
 for j,im in enumerate(chunk):sheet.paste(im,((j%3)*318,(j//3)*455))
 sheet.save(qa/f'contact-{start//6+1}.png')
print('PDF_BYTES',path.stat().st_size)
