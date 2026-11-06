import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Session} from '@supabase/supabase-js';
import {supabase} from './api';
import Workshop from './workshop';
import './styles.css';
function App(){
 const [session,setSession]=useState<Session|null>(null),[ready,setReady]=useState(false),[recovery,setRecovery]=useState(false);
 useEffect(()=>{supabase.auth.getSession().then(({data})=>{setSession(data.session);setReady(true)});
 const {data:{subscription}}=supabase.auth.onAuthStateChange((event,s)=>{setSession(s);setReady(true);if(event==='PASSWORD_RECOVERY')setRecovery(true)});
 return()=>subscription.unsubscribe()},[]);
 if(!ready)return <main className="gate"><h1>Opening the workshop…</h1></main>;
 if(recovery)return <Auth recovery onRecovered={()=>setRecovery(false)}/>;
 if(!session)return <Auth/>;
 return <Workshop key={session.user.id}/>;
}
function Auth({recovery=false,onRecovered=()=>{}}:{recovery?:boolean,onRecovered?:()=>void}){
 const [mode,setMode]=useState(recovery?'recovery':'signin'),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[name,setName]=useState(''),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const redirect=window.location.origin+import.meta.env.BASE_URL;
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setMessage('');
 try{
 if(mode==='signin'){const {error}=await supabase.auth.signInWithPassword({email,password});if(error)throw error;}
 if(mode==='signup'){const {data,error}=await supabase.auth.signUp({email,password,options:{data:{name},emailRedirectTo:redirect}});if(error)throw error;if(!data.session){setMode('verify');setMessage('Check your email to confirm your account. If the email includes a verification code, enter it below.');}}
 if(mode==='verify'){const {error}=await supabase.auth.verifyOtp({email,token:code,type:'signup'});if(error)throw error;}
 if(mode==='reset'){const {error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo:redirect});if(error)throw error;setMessage('If this address has an account, a reset link will arrive shortly.');}
 if(mode==='recovery'){const {error}=await supabase.auth.updateUser({password});if(error)throw error;onRecovered();}
 }catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
 return <main className="gate authgate"><a href="https://leavingzero.com" className="brand">LEAVING ZERO<span>THE WORKSHOP</span></a><span className="eyebrow">PRIVATE BAND WORKSPACE</span><h1>{({signin:'Your band. Behind the scenes.',signup:'Join the workshop.',verify:'Check your inbox.',reset:'Get back in.',recovery:'Set a new password.'} as any)[mode]}</h1><p className="muted">Your own account. A shared stage. New members need the band owner’s approval.</p>
 <form onSubmit={submit}>{mode==='signup'&&<label>Your name<input value={name} onChange={e=>setName(e.target.value)} autoComplete="name" required maxLength={120}/></label>}{mode!=='recovery'&&<label>Email<input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label>}{['signin','signup','recovery'].includes(mode)&&<label>Password<input type="password" autoComplete={mode==='signin'?'current-password':'new-password'} minLength={mode==='signin'?1:12} value={password} onChange={e=>setPassword(e.target.value)} required/></label>}{mode==='verify'&&<label>Confirmation code<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value)} required/></label>}
 <button disabled={busy}>{busy?'Please wait…':({signin:'Sign in',signup:'Create account',verify:'Verify email',reset:'Send reset link',recovery:'Save password'} as any)[mode]}</button></form>
 {message&&<p className="notice" role="status">{message}</p>}{!recovery&&<div className="row"><button className="textbutton" onClick={()=>{setMode(mode==='signup'?'signin':'signup');setMessage('')}}>{mode==='signup'?'Already a member? Sign in':'Create an account'}</button><button className="textbutton" onClick={()=>{setMode(mode==='reset'?'signin':'reset');setMessage('')}}>{mode==='reset'?'Back to sign in':'Forgot password?'}</button></div>}
 <p className="muted">Email verification is required. Your password goes directly to Supabase Auth.</p></main>
}
createRoot(document.getElementById('root')!).render(<App/>);
