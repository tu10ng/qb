# 用2和3号卡部署qwen3.6 27b, 最小运行, 速度为10tps

## 命令

### 创建vllm-ascend的docker

查看环境上可用的docker, 一般都有人下载过

```sh

docker images

```

![image](./e4431e9d-8faa-415f-a11b-83ab59775bd2.png)

name可以改成自己的名字

```sh
docker run -itd --privileged --name=vllm_test_demo --net=host \
      --shm-size 1g \
      --device=/dev/davinci0 \
      --device=/dev/davinci1 \
      --device=/dev/davinci_manager \
      -v /usr/local/Ascend/driver:/usr/local/Ascend/driver \
      -v /home:/home  \
      quay.io/ascend/vllm-ascend:main

```

### 确认模型权重位置

先确认模型权重位置. 不同环境不同. 这里我们找一下其他人下载的位置

```sh

find /home /data /weight /mnt /opt /models /model -maxdepth 4 -name config.json 2>/dev/null

```

![image](./63cbfc74-14bf-42ff-a05e-dba970ba49fa.png)

### 设置环境变量

重点是 `ASCEND_RT_VISIBLE_DEVICES` 和 `MODEL_PATH`

```sh

# 设置HCCL（华为集合通信库）通信缓冲区大小为512MB

export HCCL_BUFFSIZE=512

# 可用的设备，修改为0-3

export ASCEND_RT_VISIBLE_DEVICES=2,3

# 模型路径，检查文件是否存在

export MODEL_PATH="/home/weight/Qwen3.6-27B/"

```

确认环境变量

```sh

env | grep -iE model

```

### 启动vllm

```sh

vllm serve ${MODEL_PATH} \
       --host 0.0.0.0 \
       --port 8051 \
       --tensor-parallel-size 2 \
       --served-model-name qwen3.6 \
       --max-model-len 100k \
       --gpu-memory-utilization 0.8

```

![image](./e647b615-c343-40e1-9723-8b115f5ee925.png)

#### 双卡启动大概需要4-6分钟

### 关键日志

#### 配置内容

```sh

enable_prefix_caching

```

#### kvcache大小

```sh

(EngineCore pid=10492) INFO 09-23 08:41:52 [kv_cache_utils.py:1708] GPU KV cache size: 402,318 tokens

```

#### 服务拉起

```sh
Application startup complete.

```

## 关闭docker

```sh
docker stop vllm_test_demo
# 按需重启
docker start vllm_test_demo
```

# 测试vllm速度

### 修改`vllm-perf-test.py`

```py

os.system(
            f'cd {aisbench_path} && yes | python3 aisbench_test.py --input_len {input_len}')

```

# pd分离部署

## 第一次给的显存不够, 导致启动失败了

```sh

[root@gpu-node1 ~]#  docker exec -it vllm_test_demo bash
root@gpu-node1:/workspace# export ASCEND_RT_VISIBLE_DEVICES=3
vllm serve /home/weight/Qwen3.6-27B/ \
    --port 8052 \
    --kv-transfer-config '{
        "kv_connector": "MooncakeConnectorV1",
        "kv_role": "kv_consumer"
    }'

```

![image](./5edddb88-e503-4875-85fa-5a1bdd2d9d4c.png)

## 命令

```sh




```
