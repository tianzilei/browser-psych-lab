import { Model } from 'survey-core';
import { renderSurvey } from 'survey-js-ui';
import 'survey-core/survey-core.min.css';

// This module and its CSS load only on explicit entry into the survey sample.
// Future timing groups must preload all required code before their start gate.
export function mountSurveyDemo(element: HTMLDivElement) {
  const survey = new Model({
    title: '依赖检查问卷',
    completeText: '结束渲染检查',
    completedHtml: '<p>依赖渲染测试已结束。答案未保存。</p>',
    elements: [{ type: 'radiogroup', name: 'component_check', title: '当前问卷是否正常显示？',
      isRequired: true, choices: ['正常显示', '需要检查'] }],
  });
  renderSurvey(survey, element);
}
