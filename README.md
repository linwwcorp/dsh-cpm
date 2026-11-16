# 资源管理

侧边栏插件，自己保存算力节点、容器镜像和部署记录。数据在数据库插件的 PostgreSQL 里，页面、大模型和其他插件调用同一套服务方法，不转发到外部服务。

其他插件通过 `ctx.cpm` 调用：`listResources`、`createResource`、`updateResource`、`deleteResource`、`reportMetrics`、`listContainers`、`createContainer`、`updateContainer`、`deleteContainer`、`deploy`、`listDeployments`、`dashboard`。

点开插件填写镜像服务器（Docker Registry）的地址和端口后，容器仓库通过 `/v2/_catalog` 和 `/v2/{仓库}/tags/list` 列出里面的镜像。其他插件通过 `ctx.cpm.listRegistryImages()` 和 `ctx.cpm.serverSettings()` 读取。节点和部署记录仍然保存在本插件的数据库里。

## 模型工具

模型通过下列工具调用插件能力：

- 节点：`list_compute_resources`、`get_compute_resource`、`create_compute_resource`、`update_compute_resource`、`delete_compute_resource`、`test_compute_connection`、`report_compute_metrics`、`get_node_metrics`、`list_node_containers`、`control_node_containers`、`get_container_logs`、`exec_container_command`、`compute_dashboard`
- 镜像：`list_registry_images`、`list_compute_containers`、`get_compute_container`、`create_compute_container`、`update_compute_container`、`delete_compute_container`
- 部署：`deploy_compute_container`、`list_compute_deployments`
- 文件：`list_compute_files`、`create_compute_folder`、`upload_compute_file`、`read_compute_file`、`delete_compute_file`

`list_compute_resources` 直接返回每个节点的 id、名称、IP、架构、卡类型和指标，不需要先拿 id；`get_compute_resource` 只在已知 id 时使用。`list_compute_containers`、`list_registry_images`、`list_compute_deployments`、`list_compute_files` 同样返回明细。

`serverSettings` 含访问令牌，`debugTicket` 只服务于页面终端，两者不注册为模型工具。
