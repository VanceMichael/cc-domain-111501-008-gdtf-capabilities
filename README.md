# 灯具资料的模式通道与几何实例采集

Node.js 22.23.4 ESM 资料接入服务。现有服务提供单文件预览、原始字节留存和重复导入；自动结构化接入由managed模式调用。`docs/protocol.md`说明获授权来源的资料范围、引用语义和修订行为，`fixtures/raw`是极小本地合成原件，不含真实机构账号或个人数据。

## 环境与可执行命令

只需要Linux、Node.js 22.23.4和npm，无第三方包。package-lock.json与源码共同保存，安装、测试和运行不下载任何资料或依赖。

```sh
npm run build
npm test
npm run demo
```

build逐个检查src、simulator、scripts、test、acceptance内的ESM语法；test验证解释器纯逻辑、旧版预览、来源HTTP缓存与故障响应、存储重开。demo当场创建空目录并启动真实回环HTTP服务、连续调用三次managed采集（首次、重复投递、固件修订），打印当前通道记录、新旧版本的head-2地址解释、来源证据和请求列表；结束时关闭服务并清理临时目录。它不是日志回放，也不会把预览结果说成完整接入。固定小样本预计数秒，可在90秒内现场展示。

## 调用边界

`collect({base,repository,mode})`是采集入口，默认旧预览模式；`mode:'managed'`供上层请求结构化接入。返回值延续imported和complete，complete只能表示协议下已核对的完成状态，不可由HTTP200或预览成功推断。`Repository`中的records、evidence、cursors、notes是现有持久化接口，另扩展index（已取得文件索引）、interpretations（按“文档:摘要”版本化的解释）、pending（已留存未解释或待补件的待办）三个桶及对应访问器；旧记录和原始字节继续可读，旧存储重开时自动补齐新桶默认值。

managed采集只输出各模式能解释的控制地址和功能依据，不做灯光渲染、不向设备发指令。`src/gdtf.mjs`是无第三方依赖的profile解释器：几何模板被多次引用时按各实例的Break基址分别计算地址，模板本身不产生通道记录；DMXFrom保留`分子/字节数`原始精度；ChannelFunction的ModeMaster/ModeFrom切换条件、ChannelSet区间随功能记录保留；缺引用、未声明break、同字节地址冲突进入unresolved/conflict/uncertain，profile外字段隔离到unknown，均不静默覆盖。

`createSource({scenario:'legacy'|'feature'|'anomaly'|'anomaly-legacy'})`创建本地来源，提供base/state/requests/close；legacy只含首个文件，feature开放整组关联资料，anomaly开放含多break、多模式、功能切换、地址冲突、缺引用的合成资料并在round=2提供新增模式与偏移修订的独立原始件。测试用state.round、failDoc、missingDoc驱动来源变动，采集端只经HTTP观察这些变化，不读取模拟器内部数据。详细字段及公开行为矩阵见协议。

## 特性验收与恢复

```sh
npm run acceptance
```

acceptance与基线回归分开。`acceptance/managed.test.mjs`覆盖正例（实例地址、粗细字节、重开重投），`acceptance/managed-anomaly.test.mjs`按协议验证矩阵覆盖：跨文件几何实例与多break关联、缺引用与地址冲突的不确定保留、503临时失败与404缺件的待办与补件、round=2固件修订的新旧解释版本化、原始证据已留存而关系未提交时的进程终止恢复。不能删断言、固定输出样本答案或让原始证据与规范化结果错位。

## 离线容器

```sh
docker build --pull=false -t gdtf-capabilities:local .
docker run --rm --network none gdtf-capabilities:local npm test
docker run --rm --network none gdtf-capabilities:local npm run demo
```

Dockerfile使用node:22.23.4-bookworm-slim，不安装额外依赖。镜像准备好后正式命令禁网运行，来源和接入器在同一应用容器中通过回环HTTP协作，无需浏览器、设备、外部数据库或额外容器。
