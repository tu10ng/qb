# X 集群 PD 分离部署手册

> 维护：老王 · 最后更新 2026-08-21 · 适用 vLLM 0.11.x

## 机器

| 角色 | 机器 | IP | 卡 |
|---|---|---|---|
| prefill + proxy | gpu-17 | 10.0.3.17 | 0,1 |
| decode | gpu-18 | 10.0.3.18 | 2-7（0、1 卡是推荐组在用，别碰） |

模型统一放 /data/models/Qwen2.5-72B-Instruct。/home/models 下那份是旧的 tokenizer，别用。

## 0. 检查

两台机器驱动和 NCCL 版本必须一致，不一致会卡在 NCCL 初始化，日志没有任何报错，就是不动：

    nvidia-smi --query-gpu=driver_version --format=csv,noheader | sort -u
    python3 -c "import torch; print(torch.cuda.nccl.version())"

确认上次的进程已经清掉（8100/8200 端口经常被上次没杀干净的占着）：

    pkill -f "vllm serve"; sleep 3; ss -ltnp | grep -E ':(8100|8200|10001)\b'

没有输出才对。

## 1. 环境变量

两台都要设，VLLM_HOST_IP 改成本机 IP：

    export NCCL_SOCKET_IFNAME=bond0
    export NCCL_IB_DISABLE=0
    export VLLM_HOST_IP=10.0.3.17

## 2. 起 decode（gpu-18 上）

    CUDA_VISIBLE_DEVICES=2,3,4,5,6,7 nohup vllm serve /data/models/Qwen2.5-72B-Instruct --port 8200 --tensor-parallel-size 6 --max-model-len 32768 --kv-transfer-config '{"kv_connector":"P2pNcclConnector","kv_role":"kv_consumer","kv_port":"22001","kv_connector_extra_config":{"proxy_ip":"10.0.3.17","proxy_port":"30001","http_port":"8200"}}' > decode.log 2>&1 &

大概 5 分钟，看到 Application startup complete 再往下：

    tail -f decode.log | grep -m1 "Application startup complete"

## 3. 起 prefill（gpu-17 上）

    CUDA_VISIBLE_DEVICES=0,1 nohup vllm serve /data/models/Qwen2.5-72B-Instruct --port 8100 --tensor-parallel-size 2 --max-model-len 32768 --kv-transfer-config '{"kv_connector":"P2pNcclConnector","kv_role":"kv_producer","kv_port":"21001","kv_connector_extra_config":{"proxy_ip":"10.0.3.17","proxy_port":"30001","http_port":"8100"}}' > prefill.log 2>&1 &

## 4. 起 proxy（gpu-17 上）

脚本在 vllm 仓库 examples/online_serving/disaggregated_serving_p2p_nccl_xpyd/ 下，一定要用和装的 vllm 同版本的那份，不然请求会 hang：

    cd ~/vllm && git checkout v0.11.0
    nohup python3 examples/online_serving/disaggregated_serving_p2p_nccl_xpyd/disagg_proxy_p2p_nccl_xpyd.py > proxy.log 2>&1 &

proxy 默认监听 10001，服务发现端口 30001。报 `ZMQError: Address already in use` 就是 30001 被占了，换端口的话 prefill、decode 的 proxy_port 要一起改。

## 5. 验证

    curl -s http://10.0.3.17:10001/v1/completions -H "Content-Type: application/json" -d '{"model":"/data/models/Qwen2.5-72B-Instruct","prompt":"你好","max_tokens":16}'

返回里有 choices 就行。

## 6. 压测

    python3 ~/vllm/benchmarks/benchmark_serving.py --backend vllm --model /data/models/Qwen2.5-72B-Instruct --host 10.0.3.17 --port 10001 --dataset-name random --random-input-len 2048 --random-output-len 256 --num-prompts 500 --request-rate 8

跑完把 Request throughput 和 TTFT P99 贴到群里，和单体部署对比（单体大概 6.1 req/s）。

## 已知的坑

- decode 起来但 prefill 一直连不上：多半是 NCCL_SOCKET_IFNAME 没设，走了 docker0。
- 压测时 TTFT 突然飙到几十秒：kv_buffer_size 默认太小，加 "kv_buffer_size":"8e9" 到两边的 kv-transfer-config 里。
- 改了 max-model-len 以后两边必须一样，不然 decode 会报 block 数不匹配。
