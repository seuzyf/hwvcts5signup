const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
    try {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
        // 修改了查询字段，新增了玩家姓名、游戏ID和位置
        const { data, error } = await supabase.from('player_stats').select('player_name, game_id, player_role, hw_score');
        
        if (error) throw error;
        return { statusCode: 200, body: JSON.stringify(data) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
