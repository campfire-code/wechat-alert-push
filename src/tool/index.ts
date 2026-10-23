// 工具声明：订单 / 库存告警推到微信（自定义界面）。请求只发往用户自己配置的企业微信 / 钉钉 / 飞书群机器人地址。
import { BellRing } from 'lucide-react';
import { createElement } from 'react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'w15',
  name: '订单 / 库存告警推到微信',
  tagline: '读库存表和订单表，异常时推到企微 / 钉钉 / 飞书群',
  icon: BellRing,
  category: '微信私域',
  type: 'data',
  mode: 'custom',
  mainLabel: '告警',
  needsLLM: false,
  params: [],
  Main: ({ ctx }) => createElement(Main, { ctx }),
};

export default tool;
