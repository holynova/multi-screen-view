# Viewport Relay / 多屏视口同步

多尺寸网页同步测试扩展。用一个主窗口控制多个跟随窗口，支持同步导航、滚动、DOM 点击和标准表单输入。窗口标识可自由组合显示设备名称、分辨率和窗口角色；启动页还提供本地近期网址记录。

A multi-viewport web testing extension. One master controls multiple followers with synchronized navigation, scrolling, DOM-aware clicks, and standard form input. Window labels can show any combination of device name, resolution, and role, while recent URLs stay local to the browser.

密码、文件选择、隐藏字段和一次性验证码不会同步。输入同步默认关闭，所有同步数据只在当前 Chrome 会话内传递。

Passwords, file pickers, hidden fields, and one-time codes are never synchronized. Input sync is off by default, and live synchronization data remains inside the current Chrome session.

![截图](screenshot.png)

[Repo](https://github.com/holynova/multi-screen-view) · [Pages](https://holynova.github.io/multi-screen-view/)
