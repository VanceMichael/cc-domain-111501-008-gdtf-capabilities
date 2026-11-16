# 灯具资料的模式通道与几何实例采集接入约定

## 来源获取

获授权供应方网关 `/fixture` 返回文件目录、相对path、原始格式、修订号与href。GET `/raw/路径` 获得原始字节，ETag与内容绑定，条件请求304不带正文。legacy只开放第一项，feature开放完整本地资料；不需要访问真实机构或下载生产数据。目录不是完成性证明，文件可有503或404，源缺件和字段未决分别记录。真实格式范围以本文profile为准，不要求实现所引标准所有未使用扩展。

## 数据解释

源网关已将GDTF压缩容器展开为安全文件清单，raw描述遵循本profile用到的1.2节点。不要求解压ZIP或控制设备。DMXMode从Root遍历实例引用；模板Pixel本身不是Root下额外一台灯。Break中的DMXOffset为一基地址偏移，模板Offset="1,2"对应head-1粗细地址[1,2]，head-2为[5,6]。输出id=mode:实例Name:functionName，addresses保存粗细字节顺序，dmxBreak=1；功能DMXFrom的字节精度与范围端点保留，不能退化成8位。

实现侧的确定语义（`src/gdtf.mjs`）：

- 几何先注册名称再解析引用，因此模板在引用之后声明也能识别；`GeometryReference Geometry="X"`找不到模板X时记`geometry-reference-missing`，引用该模板的通道进入unresolved，不虚构实例或模板通道。
- 实例字节地址 = 引用上匹配DMXBreak的首字节基址 +（通道Offset序号 − 1）；多字节通道后续字节在break内连续，粗字节在前、细字节在后。引用未声明通道所用break时保留`{uncertain:true}`地址并记`break-missing`。
- 同一mode、同一DMXBreak、同字节被多个功能解释时双方都标`status:"conflict"`并写`address-conflict`诊断，不能任选一条覆盖；非法Offset或DMXFrom标uncertain并保留原始字符串。
- ChannelFunction的`ModeMaster/ModeFrom`原样进入`switching`，ChannelSet的DMXFrom/Physical区间进入`channelSets`；DMXFrom解析为`{raw,numerator,bytes,max}`，例如`0/2`的max为65535。
- profile白名单之外的元素与属性隔离到`unknown`，完整性因此为incomplete；隔离的未知字段不能称作已解释。
- 固件清单（json）只提供模式证据（revision与所描述文件名），不产生通道地址；描述文件与清单的关联写入解释的`firmware`字段，清单缺失或无法关联时不伪造关联。

## 持久化与修订

managed采集把状态分为三层并协同持久化：`index`登记已取得文件（path、href、revision、etag、摘要），`raw/<digest>`留存原始字节，`interpretations`以`文档id:摘要`为版本键保存规范化解释，`records`保存当前生效的通道能力记录。固件修订产生新摘要时只新增解释版本并切换当前记录，旧版本解释与其原始证据继续可读；内容未变时条件请求命中304，不重复解释、身份不膨胀。

文件先留存原始字节并写`pending`（stage=`retained-not-interpreted`），解释提交后才清除；503/404等失败写stage=`awaiting-document`并保留既有解释。进程在留存之后、提交之前终止，重开时可由pending识别待完成工作。完整性区分取得文件与解释关系两个层次，只有目录开放的每个文件都已取得、都有当前摘要对应的解释且无unresolved/conflict/unknown时complete才为true。

## 修订和补件

本地测试可用 `source.state.round=2` 驱动一次修订：fw-2的head-2偏移从5变成9，旧版本地址[5,6]仍有来源。 `state.failDoc`、`state.missingDoc`可设为目录document.id，分别模拟临时失败与缺件，清空后恢复。采集端只能经HTTP观察，不允许读取source.state或fixture.expectedIds作为采集结果。fixture.expectedIds仅是公开验收对照。原始资料及解释版本需要可核对；失败不能使已确认内容凭空消失。把已取得的文件索引、源端修订、规范化记录及字段来源协同持久化；存储结构可扩展，不规定实现架构。

完整性至少区分取得文件与解释关系两个层次；已隔离的未知字段不能被称作已解释。notes为现有人工诊断入口，可扩展结构，但信息应包含具体资料位置和未决原因。文件级原始证据由Repository.retain保留。legacy的人工预览入口继续可用；managed模式负责结构化接入。

## 验证矩阵

1. 按样本跨文件完成 几何模板与实例区分 与 DMX break及多字节偏移，不以读取目录或预览摘要代替。
2. 对同一原始资料重复投递及重开存储，规范化身份不膨胀，来源证据仍可追溯。
3. 通道功能区间和条件 不因缺件或顺序改变而被默认值掩盖；补件后只重解释受影响对象。
4. 使用round=2比较新旧解释，说明 固件模式证据与局部冲突 如何留痕。
5. 在原始资料已保存、关系尚未提交等边界终止进程，再启动能识别待完成工作；不得靠固定样本答案实现。

`acceptance/managed.test.mjs`覆盖关键正例及重启重投；`acceptance/managed-anomaly.test.mjs`按以上矩阵覆盖异常和来源变化，合成资料位于`fixtures/anomaly.json`与`fixtures/raw/10.raw`、`11.raw`、`12.raw`（12.raw为round=2独立原件，新增StudioMode并把head-2首字节基址从9改为13）。资料未齐时保留可解释未决，不为“通过”填充不存在的源值。
