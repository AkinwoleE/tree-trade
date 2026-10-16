import "../env";
import { defaultMedianSource } from "../../../web/src/lib/prices";
const q = await defaultMedianSource({ decibelKey: process.env.DECIBEL_NODE_API_KEY }).fetch();
console.log(JSON.stringify(q));
