# 本地图片人脸检测与遮罩

`local.image.face-detect` 输出真实人脸框、五点关键点、置信度和原尺寸坐标；`local.image.face-mask` 支持模糊、马赛克、眼部条带与原图局部网格。多脸可全部处理或选择最大、最靠近中心、指定索引的一张脸。

执行走原有本地任务队列、组件安装和素材登记。`vision.face-detector` 使用固定 OpenCV Zoo YuNet 模型与 ONNX Runtime 1.17.3，下载核对SHA-256，再实际CPU推理；Sharp处理图像。当前组件安装支持Windows x64，不要求系统Python。其它系统和连续视频跟踪尚未完成实机验收。

JSON合同以工具目录的 `parameter_schema` 为准。应用模式详见 [Skills 人脸处理指南](../codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow/skills/codex-yinzi-universal-video/references/face-masks.md)。

实现保留输入文件；按EXIF纠正方向，输出PNG保持原尺寸和透明度。非遮罩区域保留解码后的像素；无脸时返回零并保留图像。用户显式矩形独立记录，不能冒充自动检出的人脸。网格和眼部条带保留部分五官信息，不能提供匿名化或第三方审核承诺。

本机已完成真实模型下载、CPU推理、正常队列9项样本以及Alpha/EXIF/损坏输入/坐标上限测试；实际质量仍需核对本次检出结果。模型支持范围不保证每一张人像和动漫脸都能检出。