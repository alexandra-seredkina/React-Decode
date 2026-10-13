/*! @license Foo v1.2.3 */
// ../node_modules/lodash-es/debounce.js
var a=axios.create({baseURL:"/v2",timeout:1e4}),b="/internal";
a.interceptors.request.use(e=>(e.headers.Authorization="Bearer "+localStorage.getItem("auth.token"),e));
const api={listUsers:(e,t)=>a.get("/users",{params:{page:e,per_page:t}}),getUser:e=>a.get(`/users/${e}`).then(r=>r.data),
createUser:e=>a.post("/users",{name:e.name,email:e.email,admin:!1,tags:[]}),
removeUser:e=>a.delete(`/users/${e}`),
upload:e=>{const t=new FormData;return t.append("file",e),t.append("kind","avatar"),a.post(b+"/upload",t)}};
async function load(){const{data:e}=await api.getUser(7);return e.profile.avatar_url+e.plan.name}
function search(q){return fetch(`https://search.example.test/q?term=${encodeURIComponent(q)}&lang=en`).then(r=>r.json()).then(d=>d.hits.map(h=>h.title))}
function legacy(){const x=new XMLHttpRequest;x.open("PUT","/legacy/save");x.send("{}")}
const ws=new WebSocket("wss://rt.example.test/socket");
const env=import.meta.env.VITE_API_URL,k={apiKey:"AIzaSyA1234567890abcdefghijklmnopqrstuv",password:"hunter2hunter2"};
const router=createBrowserRouter([{path:"/",element:jsx(Layout,{}),children:[{index:!0,element:jsx(Home,{})},{path:"settings",element:jsx(Settings,{}),children:[{path:"billing",element:jsx(Billing,{})}]}]},{path:"/login",lazy:()=>import("./login.js")}]);
const Q=`query GetUser($id: ID!) { user(id: $id) { id name } }`;
function Settings(){const[e,t]=React.useState(null),[n,r]=React.useState(!1);return React.useEffect(()=>{api.listUsers(1,20).then(i=>t(i.data.items))},[]),jsx("div",{className:"settings-page",children:[jsx("button",{"aria-label":"Save changes",onClick:()=>r(!0),children:"Save"})]})}
