// Pinned native activity shapes. Export a category/label, never arguments, output or analysis.
export function nativeActivity(message){
 const meta=message?.metadata??{};
 if(meta.is_visually_hidden_from_conversation===true||meta.is_visually_hidden_reasoning_group===true)return null;
 const role=message?.author?.role;
 if(!['assistant','tool'].includes(role))return null;
 let name=role==='tool'?message.author.name:message.recipient;
 if(name==='api_tool.call_tool'){
  // The installed native client uses only this path to identify the displayed MCP action.
  try{const body=JSON.parse(message.content?.parts?.filter(p=>typeof p==='string').join('\n')??'');name=body.path;}catch{return null;}
 }
 if(typeof name!=='string'||name.length>300||!name||name==='all'||name==='assistant')return null;
 const done=role==='tool'&&message.status!=='in_progress';
 let kind;
 if(/(^|[./_])(search|browse|web)([./_]|$)/i.test(name))kind='search';
 else if(/(^|[./_])(read|review|fetch|get|list|open)([./_]|$)/i.test(name))kind='review';
 else if(/^(python|python_user_visible|python_caas|python_caas_user_visible|python_caas_cot)([.]|$)/.test(name))kind='code';
 else if(/(image_gen|dalle|t2uay3k)/.test(name))kind='image';
 else if(role==='assistant'&&/^\/?(api_tool|functions|local|mcp|connector)[./_]/.test(name))kind='tool';
 else return null;
 const labels={search:['Поиск','Поиск выполнен'],review:['Просмотр материалов','Материалы просмотрены'],code:['Выполнение кода','Код выполнен'],image:['Создание изображения','Изображение создано'],tool:['Работа с инструментом','Действие выполнено']};
 return {kind,text:labels[kind][done?1:0],state:done?'completed':'active'};
}
