import {installLanguage} from '../i18n.js';
import {messages} from '../i18n-messages.js';
export const language=installLanguage(messages);
export const t=language.t;

document.title=t('ChatGPTForge Workspace');
language.subscribe(()=>{document.title=t('ChatGPTForge Workspace');});
