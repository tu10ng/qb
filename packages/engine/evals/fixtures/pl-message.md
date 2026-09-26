这次换到 Y 集群：prefill 用 10.0.5.21，decode 用 10.0.5.22，两台 8 张卡都空着，prefill 和 decode 各用 4 卡。模型换成 /data/models/Qwen3-32B，vllm 升到 0.11.2 了。Y 集群网卡名是 eth0 不是 bond0。其他照旧。
