const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    
    try {
        const payload = JSON.parse(event.body);
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
        
        // 1. 查询数据库中是否已经存在该姓名的选手
        const { data: existingData } = await supabase
            .from('player_stats')
            .select('player_name')
            .eq('player_name', payload.player_name)
            .maybeSingle(); // maybeSingle 找不到时返回 null 而不是报错
            
        if (existingData) {
            // 2. 如果存在，则更新该选手的数据
            const { error } = await supabase
                .from('player_stats')
                .update(payload)
                .eq('player_name', payload.player_name);
                
            if (error) throw error;
        } else {
            // 3. 如果不存在，则插入新数据
            const { error } = await supabase
                .from('player_stats')
                .insert([payload]);
                
            if (error) throw error;
        }
        
        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
