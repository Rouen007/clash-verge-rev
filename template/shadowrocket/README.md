# 手机规则与 AWS 节点

`shadowrocket-cn-video-popo-futu-aws.sgmodule` 是 Shadowrocket 远程规则模块：国内常用服务直连，Google、OpenAI、Claude、GitHub 和 Futu 等走当前 `PROXY`；具体匹配顺序以模块规则为准。它不包含节点或订阅凭据。

## 使用与排查

1. 在 Shadowrocket 导入并启用远程模块，选用自己已有的节点；更新模块后需刷新规则。
2. AWS 节点订阅与这个 GitHub 规则模块是两份不同的内容。节点订阅包含敏感凭据，不要提交到公开仓库。服务端 TCP 优化无需更改规则模块或重新导入节点。
3. UDP 需要服务器、防火墙、客户端节点都支持。若在移动网络异常，可分别在 Wi-Fi 和蜂窝网络比较；UDP 并不保证网页加速。
4. 同一节点的本地条目与订阅条目表现不同时，检查 Proxy Pass 是否设置了额外代理，并检查节点参数；订阅下载本身不会给每个请求增加一跳。
5. `https://www.gstatic.com/generate_204` 可做轻量连通性和延迟检查；测速值不等于视频带宽或实际网页响应时间。

2026-10-29 服务端已启用 TCP no-delay，AWS 的 Clash YAML 节点订阅已打开 UDP。对比测试样本有限，实际收益需按设备、网络和时段观察。TradingView / IBKR 的桌面分流维持原有 YToo 设置，不由此手机规则模块控制。
