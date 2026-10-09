# Canberra Launch Program

[在线游玩](https://072529-aaa.github.io/canberra-launch-program/) · [GitHub 仓库](https://github.com/072529-aaa/canberra-launch-program)

一个可直接运行的航天器制造、发射、回收与经营模拟原型。当前版本使用 Three.js 呈现 3D 总装与飞行，但模型只消费物理状态，所有质量、推力、燃料、阻力、姿态、轨道和结算计算仍由同一套纯 JavaScript 核心负责。

## 组装实验 v1

默认进入组装实验室，试飞不扣经营资金、不发科研或合同奖励。可以调整发动机横向位置与倾角、尾翼安装高度和油箱装填，镜像安装双发动机，撤销/重做修改。质心、惯量与偏心推力参与实际模拟，不只是模型外观变化。

装配视图支持拖动发动机和尾翼；选件检查器提供同等数值调节，适合触屏。观察视图可以旋转检查模型。试飞结束后显示实测曲线，并与本次打开游戏期间的上次实验对照；物理笔记可主动打开。

首版仍是受约束的轴向装配和发动机安装面，不包含任意连接树、侧助推独立燃料路由或完整三维动力学。供电和热模型也尚未完善。经营模式继续执行零件解锁、容量、预算和合同约束。

## 启动

需要 Python 3、Node.js 18+ 和现代浏览器。

```powershell
python serve.py
```

浏览器打开：

```text
http://127.0.0.1:4173
```

Three.js 已作为本地依赖安装，页面通过 import map 加载，不需要前端构建步骤。
只有在本地依赖缺失时才需要用 `npm.cmd install` 安装；Windows 上可直接用上述 Python 命令启动。

## 自动化测试

```powershell
npm test
```

测试覆盖：

- 大气密度、圆轨道、固定步长积分和长时稳定性
- 单级与两级火箭质量、推力、分离和速度增量
- 10 km 探空任务、降落伞回收与成功结算
- 发射扣费、科研解锁和基地升级
- 装填、偏心力矩、镜像、撤销、旧存档配置以及 30/60/144 Hz 帧率独立性

浏览器验证覆盖：

- 1280 x 720 桌面端 3D 总装与飞行 HUD
- 390 x 844 手机竖屏导航与飞行控制
- 3D 零件选择、零件目录添加、构型重置
- 点火、开伞、着陆、资源结算完整闭环

## 当前玩法

- **任务中心：** 查看合同、奖励、任务目标和火箭准备度。
- **总装车间：** 装配视图拖动发动机和尾翼，调装填与安装角，镜像和撤销；观察视图旋转检查。
- **发射准备：** 查看 3D 飞行器预览、系统检查、成本与任务目标。
- **飞行控制：** 3D 行星场景、连续轨道预测、实时遥测、SAS、分级、开伞和载荷部署。
- **任务结算：** 逐项目标核验、资源入账和遥测记录。
- **失败分析：** 根据触地速度、动压、失稳或速度增量不足给出下一轮修改建议。
- **研发基地：** 科技树解锁零件，基地设施提高质量上限、零件上限、科研倍率和回收率。

## 操作

- 装配模式点击选件、拖动发动机/尾翼；观察模式拖动旋转视角，滚轮缩放。
- 飞行中左右方向键或 A/D 控制转向，Shift/Ctrl 调整节流，空格分级，P 开伞，T 切换 SAS。
- 触屏设备使用底部控制台；手机主导航固定在屏幕底部。

首个合同需要达到 10 km 后安全回收。需要先让火箭越过顶点，在下落且高度低于 8 km 时展开降落伞。首个探空构型已经包含完成任务所需的座舱、燃料箱、发动机、尾翼和降落伞。

详细设计见 [DESIGN.md](./DESIGN.md)。
新方向与后续任务见 [DEVELOPMENT_SPEC.md](./DEVELOPMENT_SPEC.md)。

## 开发与验证

核心规则在 `src/craft.js`、`src/physics.js`、`src/missions.js`、`src/state.js`，渲染不可修改这些模块的权威状态。新增物理或组装功能需增加纯逻辑测试并保持默认探空回收路径通过；修改页面还需桌面和手机的实际浏览器验收。

```powershell
node --test tests/*.test.mjs
node --check src/app.js
node --check src/app3d.js
```

仓库包含 GitHub Actions 逻辑测试和语法检查；这不替代浏览器/WebGL 验收。`node_modules`、构建目录、浏览器会话、截图和运行日志不会提交到源码仓库。

## 公网部署

向 `main` 推送会运行测试，并使用 GitHub Pages 发布静态游戏。构建仅包含页面、样式、游戏代码、资源以及必要的 Three.js 文件和许可证；不上传本地日志、测试记录或服务器脚本，不依赖外部 CDN。

```powershell
npm.cmd ci --ignore-scripts
python -m unittest discover -s tests -p "test_*.py"
python scripts/build_site.py
```

构建输出到空的 `dist/` 目录。若已有输出，构建会拒绝覆盖，需明确清理旧构建或用 `--output dist/release-name` 选择新目录。GitHub Actions 使用干净检出，不需要清理。Pages 上的存档保存在玩家自己的浏览器，跨设备不会自动同步。

本项目为独立原型；第三方组件许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

已安装 Playwright CLI 时，可在本地服务运行后使用保存的验收脚本；请在同一次终端调用中连续打开和验证，使用独立测试会话，避免影响已有浏览器数据。

```powershell
playwright-cli.cmd --session assembly-v1 open http://127.0.0.1:4173 --headed
playwright-cli.cmd --session assembly-v1 run-code --filename scripts/pw_assembly_v1.js
```

实验对照和经营模式另由 `scripts/pw_experiment_career_v1.js` 验证。脚本会在自己的测试会话恢复基础构型，不应在玩家的浏览器会话运行。
触屏交互由 `scripts/pw_touch_v1.js` 验证。多轮经营验收使用真实物理的额外固定步加速，桌面/手机脚本另行覆盖正常实时飞行。
这三份脚本沿用当前浏览器的站点地址，也可在打开公网 Pages 页面后运行，用同一流程验收正式部署。
