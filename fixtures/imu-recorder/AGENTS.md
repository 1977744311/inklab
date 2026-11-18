# IMU 引导录制

- **Name**: IMU 引导录制
- **Summary**: InkLab 的引导录制工具：在眼镜上逐段提示动作，录下姿态、加速度计、陀螺仪的真实读数

InkLab 的 fixture，不是产品代码。由 `inklab-device imu-guide` 推到眼镜上，录到的数据经 logcat
回到 InkLab，存成工程的 `e2e/traces/<名字>.json`（格式见 `lib/imu-trace.mjs`）。
