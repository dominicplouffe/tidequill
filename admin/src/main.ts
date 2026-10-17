import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { installLinkInterceptor } from "./lib/router.svelte.ts";

installLinkInterceptor();
const app = mount(App, { target: document.getElementById("app")! });
export default app;
